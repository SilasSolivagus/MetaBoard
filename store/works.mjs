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

/**
 * 工作项在流程里的位置。**通用取值,不带领域行话** —— 这一条改过一次:
 * 最初写的是 initial/researching/drafting/in_review/revising/done,那是内容生产的
 * 行话,而且和事件的 kind(research/draft/revise)重复了。状态说的是「这活儿在你的
 * 流程里走到哪」,kind 说的是「干了什么」,两件事。混在一起,换个领域(法务审查、
 * 调研报告)就得改 schema,而 spec 第 1 节写的终点是通用产品。
 *
 * 形式照 dashi(CHECK 式固定枚举)。dashi 试过让每个项目自定义工作流,后来把整套
 * 删掉了(0009_remove_workflow_schema.sql:DROP TABLE workflow_workspaces),
 * 退回固定枚举 —— 用退兵验证出来的结论,值得照抄。领域差异以后走标签,不走状态。
 */
export const STATUSES = /** @type {const} */ (
  ['backlog', 'todo', 'in_progress', 'in_review', 'done'])

/**
 * 早期写进日志的状态值 → 现在的值。日志只追加,旧行改不了,只能在读的时候映射。
 * 不在 validate 里放行这些值:新的写入必须用新枚举。
 */
/** @type {Record<string, string>} */
const LEGACY_STATUS = { initial: 'backlog', researching: 'in_progress', drafting: 'in_progress', revising: 'in_progress' }

/** 操作词表。加新 op 必须同时加折叠分支 —— fold 见到不认识的 op 会抛。 */
export const OPS = /** @type {const} */ (['create', 'status', 'title', 'archive'])

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

/** @returns {string} 日志路径。METABOARD_HOME 覆盖默认位置(测试用)。 */
export function storePath() {
  const home = process.env.METABOARD_HOME ?? join(homedir(), '.metaboard')
  return join(home, 'works.jsonl')
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
  if (op.op === 'create' && (typeof op.title !== 'string' || op.title === '')) {
    throw new Error('create needs a title')
  }
  if (op.op === 'title' && (typeof op.to !== 'string' || op.to === '')) throw new Error('title needs `to`')
  if (op.op === 'status') {
    if (!STATUSES.includes(op.to)) throw new Error(`unknown status: ${JSON.stringify(op.to)}`)
    if (op.from !== undefined && !STATUSES.includes(op.from)) {
      throw new Error(`unknown status: ${JSON.stringify(op.from)}`)
    }
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
        status: 'backlog',
        actor: op.actor,
        createdAt: op.ts,
        updatedAt: op.ts,
        archivedAt: undefined,
      })
      continue
    }
    const t = works.get(id)
    // 指向不存在工作项的操作跳过 —— 同样只可能来自外部编辑。
    if (t === undefined) continue
    if (op.op === 'status') t.status = LEGACY_STATUS[op.to] ?? op.to
    else if (op.op === 'title') t.title = op.to
    else if (op.op === 'archive') t.archivedAt = op.ts
    t.updatedAt = op.ts
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
 * 这个工作项 id 存在吗。四个内容工具共用这一个判据 —— 各写一份就会漂移,
 * 这个项目已经被「两份实现各自演化」咬过三次。
 *
 * 归档过的工作项仍然算存在:归档是看板可见性,不是删除。已经开工的内容还要能继续记录。
 * @param {string} id
 * @param {string} [path]
 */
export function workExists(id, path) {
  return fold(readOps(path)).has(id)
}
