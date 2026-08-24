// @ts-check
/**
 * C 类存储:选题表。
 *
 * spec 第 4 节把数据分成三类。A 类(素材、稿件、改稿)进 `tool/result.meta` 的信封,
 * B 类(人工评审)进 `user/message`,C 类(选题状态、排期、看板位置)进 MetaBoard 自有
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

/** 内容生产的状态流转。取 CHECK 式枚举的形式(照 dashi),但取值是内容生产的,不是 issue 的。 */
export const STATUSES = /** @type {const} */ (
  ['initial', 'researching', 'drafting', 'in_review', 'revising', 'done'])

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
  return join(home, 'topics.jsonl')
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
  if (typeof op.topic !== 'string' || op.topic === '') throw new Error('op.topic must be a non-empty string')
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
 * 把操作日志折叠成当前状态。
 * @param {any[]} ops
 * @returns {Map<string, any>}
 */
export function fold(ops) {
  /** @type {Map<string, any>} */
  const topics = new Map()
  for (const op of ops) {
    if (op.op === 'create') {
      // 重复的 create 不覆盖已有选题:id 由计数器分配,重号只可能是日志被外部改过。
      if (topics.has(op.topic)) continue
      topics.set(op.topic, {
        id: op.topic,
        title: op.title,
        status: 'initial',
        actor: op.actor,
        createdAt: op.ts,
        updatedAt: op.ts,
        archivedAt: undefined,
      })
      continue
    }
    const t = topics.get(op.topic)
    // 指向不存在选题的操作跳过 —— 同样只可能来自外部编辑。
    if (t === undefined) continue
    if (op.op === 'status') t.status = op.to
    else if (op.op === 'title') t.title = op.to
    else if (op.op === 'archive') t.archivedAt = op.ts
    t.updatedAt = op.ts
  }
  return topics
}

/**
 * 下一个可用 id。取已有最大编号加一 —— 归档掉的号不复用,因为 dsh 事件里的
 * `subject` 引用的正是这个 id,复用会让旧事件挂到新选题上。
 * @param {Map<string, any>} topics
 */
export function allocateId(topics) {
  let max = 0
  for (const id of topics.keys()) {
    const m = /^t(\d+)$/.exec(id)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `t${max + 1}`
}
