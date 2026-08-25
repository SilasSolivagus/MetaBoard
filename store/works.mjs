// @ts-check
/**
 * C 类存储:工作项表。
 *
 * spec 第 4 节把数据分成三类。A 类(素材、稿件、改稿)进 `tool/result.meta` 的信封,
 * B 类(人工评审)进 `user/message`,C 类(工作项状态、排期、看板位置)进 MetaBoard 自有
 * 存储 —— 理由是「是可变状态不是事件,且不应进模型上下文」。这个文件就是 C 类。
 *
 * ── 为什么是只追加的日志,不是一张存当前值的表 ──
 * 状态变更来自看板操作,不是工具调用,所以它天生不在 dsh 的事件流里。如果把当前值
 * 存成一张表、再单开一张审计表记变更,得到的就是参照项目 dashi-taskboard 的形状:
 * tasks 表 + task_activities 表 + 另一套 ai_chat_events,三本账各自为政。
 * 而「没有统一事件流」正是本项目立论要补的那一层。
 *
 * 所以这里存的是变更本身,当前状态是折叠出来的。代价是每次读都全扫(这个规模下
 * 是零成本),换来的是状态变更与 dsh 工作事件可以按时间戳合并成一条时间线。
 *
 * ── 为什么 id 由计数器分配 ──
 * 沿用 dashi 的做法:tasks.identifier 由 projects.next_task_number 发号,
 * 没有人给任务起名字。模型只能引用已分配的 id,不能自己取名 —— 于是
 * 「同一个选题被写成 topic:nas / topic:NAS / topic:nas-2026」在结构上不可能发生。
 * 实测数据支持这个决定:改造前这台机器的历史会话里有 13 个不同的 subject,
 * 其中 9 个是开发期的测试垃圾。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withLock } from './lock.mjs'

/**
 * 工作项在流程里的位置。整套照搬参照项目 dashi-taskboard —— 状态集、看板/二级的
 * 划分、以及谁能把它挪到哪里,都跟它一致。
 *
 * 这一条改过两次,值得记下来:
 *
 * 第一版写的是 initial/researching/drafting/in_review/revising/done。那是内容生产的
 * 行话,而且和事件的 kind 重复了(状态说「在流程里走到哪」,kind 说「干了什么」)。
 *
 * 第二版我想砍掉 backlog 与 todo 的区分,理由是「一个人写东西没有迭代规划的仪式,
 * 这条线没有触发时刻,会腐烂」。去读了 dashi 才发现推错了原因 —— 那条线的意义不是
 * 计划,是**授权**。它的 SKILL.md 写得很直:
 *
 *   Treat `backlog` as not approved for execution. Unless the user explicitly
 *   authorizes that issue, do not claim it, move it to another status, or
 *   perform task work.
 *
 * 立项之前 agent 什么都不许干,立项之后任何 agent 都能来接。这条线有后果,所以不会烂。
 * 我们这里把它做得比 dashi 更硬:dashi 靠 prompt 里的规矩约束 agent,我们让工具直接
 * 拒绝未立项的工作项(见 lib/tools/*.js 的 workState 校验)。规矩变成机制。
 */
export const STATUSES = /** @type {const} */ (
  ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])

/** 看板上的四列。照 dashi 的 MAIN_STATUSES —— 看板只放已授权的流水线。 */
export const MAIN_STATUSES = /** @type {const} */ (['todo', 'in_progress', 'blocked', 'in_review'])

/** 不上看板的:待立项、完成、取消。收在别处,免得看板变成堆场。 */
export const SECONDARY_STATUSES = /** @type {const} */ (['backlog', 'done', 'canceled'])

/** 中文标签,沿用 dashi 的措辞 —— 它的用词比通用译法准。 */
export const STATUS_LABEL = /** @type {Record<string, string>} */ ({
  backlog: '待立项',
  todo: '等待认领',
  in_progress: '处理中',
  blocked: '遇到阻碍',
  in_review: '等你确认',
  done: '完成',
  canceled: '取消',
})

/**
 * agent 不能自己设的状态。照 dashi 的 AGENTS.md:
 * "Never move an issue to `done` unless the user explicitly accepts it."
 * 它的批次完成检查里还专门有一条 "changed issues are in `in_review`, not `done`"。
 * agent 可以设 blocked(干不下去)和 canceled(不打算干了),但**不能宣布完成**。
 */
export const AGENT_FORBIDDEN = /** @type {const} */ (['done'])

/**
 * 早期写进日志的状态值 → 现在的值。日志只追加,旧行改不了,只能在读的时候映射。
 * 不在 validate 里放行这些值:新的写入必须用现行枚举。
 * @type {Record<string, string>}
 */
const LEGACY_STATUS = { initial: 'backlog', researching: 'in_progress', drafting: 'in_progress', revising: 'in_progress' }

/**
 * 操作词表。加新 op 必须同时加折叠分支 —— 没分支不等于被 fold 悄悄吞掉:version 与
 * updatedAt 对任何认得的 op 都会前进(乐观锁数的是「作用过几条 op」,不能被漏掉的分支骗过),
 * 没分支的 op 只是不改任何字段,看着变了、其实没变,一样是个坑。
 */
export const OPS = /** @type {const} */ (['create', 'status', 'title', 'archive', 'comment', 'project'])

export const ACTORS = /** @type {const} */ (['user', 'agent'])

/**
 * 单行上限。这条是设计约束,不是原子性保证的边界 —— 那个说法我写错过一次,
 * 在这里改正:PIPE_BUF(4096)的原子写保证是给管道的,不是给普通文件的。
 * 普通文件的 O_APPEND 保证的是「每次写之前把偏移原子地移到文件末尾」(防止两个
 * 写者互相覆盖),并不保证一次 write 不被拆开。
 *
 * 实测(macOS/APFS,两进程各追加 200 行、每行约 18KB):400 行零损坏。所以在这台
 * 机器上,即使远超 4096 也没有观察到交错。
 *
 * 那为什么还留这条上限?两个真实理由,都与原子性无关:
 *   1. 它是「内容不进 C 类日志」这条设计意图的强制执行点。正文属于 dsh 的信封,
 *      这里只放 id 与短字段;有人想往里塞正文时,这条会先拦住。
 *   2. 短行让「一次写被拆开」这个理论风险小到可以忽略,也让日志能被人直接读。
 * 换句话说:这是个纪律,不是个证明。
 */
export const MAX_LINE_BYTES = 4096

/**
 * 单条 comment 正文的上限。
 *
 * 这不是性能考虑,是「正文进信封、不进 C 类日志」那条分工的执行点。comment 承载的是
 * 要求、打回的理由、agent 的自述 —— 都是摘要。有人想把稿件塞进来时,这条先拦住。
 * 3000 字节约合 1000 个汉字,留给单行上限 4096 的余量足够放下 id 与时间戳。
 */
export const MAX_COMMENT_BYTES = 3000

/** ~/.metaboard/。projects.mjs 也要用,所以抽出来 —— 两处各写一份就会漂移。 */
export function metaboardHome() {
  return process.env.METABOARD_HOME ?? join(homedir(), '.metaboard')
}

/** @returns {string} 日志路径。METABOARD_HOME 覆盖默认位置(测试用)。 */
export function storePath() {
  return join(metaboardHome(), 'works.jsonl')
}

/**
 * 校验一个操作。不合法就抛 —— 宁可写不进去,也不能让不合法的行进日志:
 * 日志是只追加的,写进去就删不掉了。
 * @param {any} op
 */
function validate(op) {
  if (typeof op !== 'object' || op === null) throw new Error('op must be an object')
  if (!OPS.includes(op.op)) throw new Error(`unknown op: ${JSON.stringify(op.op)}`)
  if (!ACTORS.includes(op.actor)) throw new Error(`unknown actor: ${JSON.stringify(op.actor)}`)
  if (typeof op.work !== 'string' || op.work === '') throw new Error('op.work must be a non-empty string')
  if (typeof op.ts !== 'string' || Number.isNaN(Date.parse(op.ts))) throw new Error('op.ts must be an ISO timestamp')
  if (op.op === 'create') {
    if (typeof op.title !== 'string' || op.title === '') throw new Error('create needs a title')
    // 建项路径决定初始状态,而路径本身就编码了授权:
    // 你在 CLI 里记下一个想法 → 待立项;agent 在对话里建 → 你刚开口要了,即已授权。
    if (op.status !== undefined && !STATUSES.includes(op.status)) {
      throw new Error(`unknown status: ${JSON.stringify(op.status)}`)
    }
  }
  if (op.op === 'title' && (typeof op.to !== 'string' || op.to === '')) throw new Error('title needs `to`')
  if (op.op === 'status') {
    if (!STATUSES.includes(op.to)) throw new Error(`unknown status: ${JSON.stringify(op.to)}`)
    if (op.from !== undefined && !STATUSES.includes(op.from)) {
      throw new Error(`unknown status: ${JSON.stringify(op.from)}`)
    }
    // AGENT_FORBIDDEN 原先只是个带注释的常量,没有一处代码查过它 —— 于是
    // {actor:'agent', op:'status', to:'done'} 一直是写得进去的,规矩全靠没人走那条路。
    // 检查放在这里:validate 已经在管 agent 特有的规矩(下面那条绑定就是),
    // 而这里是唯一一个所有写入都必经的点。
    if (op.actor === 'agent' && AGENT_FORBIDDEN.includes(op.to)) {
      throw new Error(
        `an agent may not move a work item to ${op.to} — only the person accepts work as done. `
        + 'Hand it back with in_review instead.')
    }
    // 绑定只对 agent 强制。人不是会话,人挪状态不需要出示身份 —— 而且人挪进
    // in_progress 会顺带清掉绑定,这就是 R28 说的「人可以夺权」。
    if (op.actor === 'agent' && op.to === 'in_progress' && op.binding === undefined) {
      throw new Error('an agent moving a work item to in_progress must carry a binding')
    }
    if (op.binding !== undefined) {
      const b = op.binding
      if (typeof b?.session !== 'string' || b.session === '' || typeof b.workspace !== 'string' || b.workspace === '') {
        throw new Error('binding needs non-empty session and workspace')
      }
    }
  }
  if (op.op === 'comment') {
    if (typeof op.body !== 'string' || op.body.trim() === '') throw new Error('comment needs a non-empty body')
    const n = Buffer.byteLength(op.body, 'utf8')
    if (n > MAX_COMMENT_BYTES) {
      throw new Error(
        `comment body is ${n} bytes, over the ${MAX_COMMENT_BYTES}-byte limit. A comment carries `
        + 'requirements, a hand-back reason, or a summary of what you did — the text itself belongs '
        + 'in the dsh envelope.')
    }
  }
  if (op.op === 'project' && op.to !== null && (typeof op.to !== 'string' || op.to === '')) {
    throw new Error('project op needs `to`: a project id, or null to unassign')
  }
}

/**
 * 追加一个操作。
 * @param {any} op
 * @param {string} [path]
 */
export function appendOp(op, path = storePath()) {
  validate(op)
  const line = JSON.stringify(op) + '\n'
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > MAX_LINE_BYTES) {
    throw new Error(
      `op line is ${bytes} bytes, over the ${MAX_LINE_BYTES}-byte limit. Operations carry ids `
      + 'and short fields only — content belongs in the dsh envelope, not in this log.')
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, line, { encoding: 'utf8' })
  return op
}

/**
 * 读回全部操作,按文件顺序。
 * 损坏的行跳过而不是抛:一行坏了不该让整个看板打不开。日志只追加,损坏只可能
 * 来自外部编辑或写入中断,那时能读多少是多少比全盘失败好。
 * @param {string} [path]
 * @returns {any[]}
 */
export function readOps(path = storePath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return []
    throw error
  }
  /** @type {any[]} */
  const ops = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      ops.push(JSON.parse(line))
    } catch {
      // 跳过损坏的行。
    }
  }
  return ops
}

/**
 * 操作指向的工作项 id。字段名从 `topic` 改成了 `work`(工作项这个名字是后来定的),
 * 早期的行还带着旧名 —— 日志只追加,旧行改不了,只能在读的时候认两个名字。
 * @param {any} op
 */
export function opWork(op) {
  return op.work ?? op.topic
}

/**
 * 把操作日志折叠成当前状态。
 * @param {any[]} ops
 * @returns {Map<string, any>}
 */
export function fold(ops) {
  /** @type {Map<string, any>} */
  const works = new Map()
  for (const op of ops) {
    const id = opWork(op)
    if (id === undefined) continue
    if (op.op === 'create') {
      // 重复的 create 不覆盖已有工作项:id 由计数器分配,重号只可能是日志被外部改过。
      if (works.has(id)) continue
      works.set(id, {
        id,
        title: op.title,
        status: op.status ?? 'backlog',
        actor: op.actor,
        createdAt: op.ts,
        updatedAt: op.ts,
        archivedAt: undefined,
        version: 1,
        comments: /** @type {any[]} */ ([]),
        project: undefined,
        binding: undefined,
      })
      continue
    }
    const t = works.get(id)
    // 指向不存在工作项的操作跳过 —— 同样只可能来自外部编辑。
    if (t === undefined) continue
    if (op.op === 'status') {
      t.status = LEGACY_STATUS[op.to] ?? op.to
      // 绑定跟着状态操作走:带绑定的状态操作就是认领,不带的就是释放。
      //
      // 原先的条件是「落地状态是 in_progress 才留绑定」。那条把绑定绑在了一个
      // 状态上,而绑定问的其实是「现在这活儿在谁手里」—— 交回等你确认之后 agent
      // 还可能被打回来接着改,那时它照样该独占。改成看操作本身带不带绑定:
      // 人挪状态从不带绑定,所以人挪状态仍然是释放(R28,人可以夺权);
      // agent 认领带绑定;agent 交回不带,于是交回就是释放。
      t.binding = op.binding
    } else if (op.op === 'title') t.title = op.to
    else if (op.op === 'archive') t.archivedAt = op.ts
    else if (op.op === 'comment') t.comments.push({ ts: op.ts, actor: op.actor, body: op.body, callId: op.callId })
    else if (op.op === 'project') t.project = op.to ?? undefined
    t.updatedAt = op.ts
    t.version += 1
  }
  return works
}

/**
 * 下一个可用 id。取已有最大编号加一 —— 归档掉的号不复用,因为 dsh 事件里的
 * `subject` 引用的正是这个 id,复用会让旧事件挂到新工作项上。
 *
 * 前缀 `t` 不承载含义,别去「修」它。工作项这个名字是后来才定的,而那时 t1/t2 已经
 * 写进不可变的 dsh 事件里(subject: t1)。改前缀等于切断那些链接,换来的只是好看。
 * @param {Map<string, any>} works
 */
export function allocateId(works) {
  let max = 0
  for (const id of works.keys()) {
    const m = /^t(\d+)$/.exec(id)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `t${max + 1}`
}

/**
 * 建一个工作项:发号与写下 create 在同一把锁里跑完,返回分配到的 id。
 *
 * 分成两步(先 allocateId、再 appendOp)的写法在这里是错的,而且错得不响:两个进程
 * 同时读到「最大号是 t0」会都挑 t1,日志里落两条 create,fold 只认第一条(重复的
 * create 不覆盖已有工作项),后一个调用方拿着 t1 去写的却是别人的工作项 —— 它的工具
 * 结果里那句「记为 t1:<自己的标题>」当场就是假的,而且这条假话会渲染进 dsh 的账本。
 *
 * 所以发号这件事不给调用方做:allocateId 只用来算号,建项一律走这里。
 *
 * @param {{ actor: string, title: string, status?: string, project?: string, ts?: string }} fields
 * @param {string} [path]
 * @returns {string} 分配到的 id
 */
export function createWork(fields, path = storePath()) {
  return withLock(path, () => {
    const ts = fields.ts ?? new Date().toISOString()
    const work = allocateId(fold(readOps(path)))
    /** @type {any[]} */
    const ops = [{ ts, actor: fields.actor, work, op: 'create', title: fields.title, status: fields.status }]
    // 项目归属跟 create 一起落地。分开写会有一瞬间的工作项没有归属,
    // 而那一瞬间别人读到的它就是无归属的 —— 一样是账面与事实不符。
    if (fields.project !== undefined) {
      ops.push({ ts, actor: fields.actor, work, op: 'project', to: fields.project })
    }
    // 先全部 validate 再逐条写,和 appendChecked 一样是全有或全无:
    // 归属那条不合法时,create 也不该已经落地。
    for (const op of ops) validate(op)
    for (const op of ops) appendOp(op, path)
    return work
  })
}

/**
 * 工作项当前的状态,给工具做准入判断用。四个内容工具共用这一个判据 ——
 * 各写一份就会漂移,这个项目已经被「两份实现各自演化」咬过三次。
 *
 * 归档过的工作项仍然算存在:归档是看板可见性,不是删除。
 *
 * 第二个参数从 path 变成了选项对象,因为准入判断多了一条:别的会话认领着的工作项
 * 不许碰。这条本可以单开一个函数,但那正是「两份判据各自演化」的起点。
 *
 * @param {string} id
 * @param {{ path?: string, session?: string }} [opts]
 * @returns {{ ok: true, status: string, version: number } | { ok: false, reason: string }}
 */
export function workState(id, opts = {}) {
  const w = fold(readOps(opts.path)).get(id)
  if (w === undefined) return { ok: false, reason: `unknown work item: ${id}` }
  if (w.status === 'backlog') {
    return { ok: false, reason: `${id} is not approved for execution (待立项). Ask the person to approve it first; do not start work on it.` }
  }
  if (w.status === 'canceled') return { ok: false, reason: `${id} was canceled (取消)` }
  if (w.binding !== undefined && w.binding.session !== opts.session) {
    return { ok: false, reason: `${id} is claimed by another conversation (${w.binding.session}). Never take over another agent's claim — report it instead.` }
  }
  return { ok: true, status: w.status, version: w.version }
}

/**
 * 认领:没人占着就归写的人,并记下是哪个会话在做。
 *
 * 照 dashi 的 threadBinding。它要求五段身份齐全才允许认领,少一段就停下 ——
 * 「never create a legacy binding containing only threadId」。半个绑定比没有绑定
 * 更坏,因为它看起来像有保护。我们的两段是会话与工作区,同样是齐了才写。
 *
 * 触发条件改过一次。原先只认 todo → in_progress 这一条边,理由是「认领就是从
 * 等待认领里领走」。那条让绑定只在工作项的第一程里成立:agent 交回、人打回之后
 * 工作项处在 in_progress 而没有绑定,再有会话来写也不会触发认领,于是两个会话
 * 可以同时往同一个工作项上写。而「打回重改」正是这个产品的主循环。
 *
 * 现在的规则:**当前没有绑定就归第一个来写的会话**,不管它是什么状态 ——
 * 这和 todo 原本的规矩是同一条,只是不再挑状态。已经绑给别人的仍然拒绝(R28:
 * 人可以夺权,agent 不行)。绑定由状态操作承载,所以在非 todo 的状态上认领写的是
 * 一条 from 与 to 相同、带着绑定的状态操作。
 *
 * 读当前状态放在锁里,不接调用方先前读到的状态 —— 那个值在写下去的一刻可能已经旧了。
 *
 * @param {string} id
 * @param {{ session: string, workspace: string }} binding
 * @param {string} [path]
 */
export function claim(id, binding, path = storePath()) {
  withLock(path, () => {
    const w = fold(readOps(path)).get(id)
    if (w === undefined) return
    if (w.binding !== undefined) {
      // 已经是自己的:不重复写。日志里堆一串同样的流转,读的人分不出哪次是真的交接。
      if (w.binding.session === binding.session) return
      throw new ConflictError('binding',
        `${id} is claimed by another conversation (${w.binding.session}). Never take over another `
        + "agent's claim — report it instead.")
    }
    // agent 不许写的状态上不认领。认领是靠状态操作承载绑定的,写不了状态就认领不了;
    // 而这些是终态,没有第二个会话会来抢,不绑定也不会有人打架。
    if (AGENT_FORBIDDEN.includes(w.status)) return
    const to = w.status === 'todo' ? 'in_progress' : w.status
    appendOp(
      { ts: new Date().toISOString(), actor: 'agent', work: id, op: 'status', from: w.status, to, binding },
      path)
  })
}

/**
 * 写不进去的两种理由。分成 code 而不是两个类:调用方(工具)统一把它转成
 * 结果里的 error 字符串,分类是给人读的,不是给 catch 分支用的。
 */
export class ConflictError extends Error {
  /** @param {'version'|'binding'} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'ConflictError'
    this.code = code
  }
}

/**
 * 带前置条件的追加。三步(读版本 → 比对 → 追加)在锁里跑完。
 *
 * 传数组时是全有或全无:先全部 validate 再一条条写。中途一条不合法,前面的也不落地。
 * 这条对 `return`(打回 = 留言 + 改状态)和 `metaboard_report` 的交回是必需的 ——
 * 留言写下了而状态没改,读的人会以为活儿还在 agent 手上。
 *
 * @param {any|any[]} ops
 * @param {{ ifVersion?: number, binding?: { session: string, workspace: string } }} [opts]
 * @param {string} [path]
 * @returns {any[]} 写进去的操作
 */
export function appendChecked(ops, opts = {}, path = storePath()) {
  const list = Array.isArray(ops) ? ops : [ops]
  if (list.length === 0) return []
  return withLock(path, () => {
    const id = opWork(list[0])
    const w = fold(readOps(path)).get(id)
    if (w === undefined) throw new Error(`unknown work item: ${id}`)
    if (opts.ifVersion !== undefined && w.version !== opts.ifVersion) {
      throw new ConflictError('version',
        `${id} changed while you were working (it is at version ${w.version}, you had ${opts.ifVersion}). `
        + 'Read it again and reconcile before writing.')
    }
    if (w.binding !== undefined && list.some((o) => o.actor === 'agent')
      && w.binding.session !== opts.binding?.session) {
      // R28:人可以夺权,agent 不行。
      throw new ConflictError('binding',
        `${id} is claimed by another conversation (${w.binding.session}). Never take over another `
        + "agent's claim — report it instead.")
    }
    for (const op of list) validate(op)
    return list.map((op) => appendOp(op, path))
  })
}
