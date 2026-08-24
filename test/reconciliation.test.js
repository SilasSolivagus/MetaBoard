// @ts-check
/**
 * 账本对账:拿真实会话日志重放一遍,检查账本和日志说的是不是同一件事。
 *
 * 为什么单独一套。本项目至今六个真实缺陷,五个是同一个形状 —— 账本没有崩溃,
 * 而是平静地显示了一个不对的值:失败的调用显示成绿色的成功、引用显示成
 * 字面量 undefined、失败的评审整行消失。崩溃会被发现,这种不会。
 *
 * 这里的每一条都是「日志里发生的事」和「账本上显示的事」之间的对账规则,
 * 不关心实现怎么写。它们不需要预见到哪两个决定会相撞 —— 撞出来的结果一定会
 * 违反其中某一条。
 *
 * 事件来自 test/fixtures/,由 scripts/harvest-fixture.mjs 从真实会话采出,
 * 不是手写的。手写事件形状是本项目三次「测试全绿但现实是错的」的共同根因。
 *
 * ── 灵敏度:哪几条真抓到过东西 ──
 * 把历史上真实发生过的缺陷逐个放回生产代码,验证对应的不变量会变红:
 *   R20(抑制不看条件,失败的评审整行消失)      → 守恒 红
 *   R19(失败证据只读 data.error,失败显示成绿的) → 不说假话 红
 *   R18(评审调用行在数据层被丢弃)              → 守恒 + 引用必须解析 红
 * 三条都是这份夹具当场验过的,不是推断。
 *
 * ── 这份夹具没覆盖到的 ──
 * 两条不变量目前没有对应的破坏样本,它们守着的路径这份夹具里没有:
 *   1. 「不显示 undefined」—— 需要一次被 run_code 子派发的上游调用
 *      (presentationMeta 不执行 → 那一行没有 contentKind)。这条路径至今没有
 *      被真实观察过,M2 是审查从工具描述里那句 "never inside run_code" 推出来的。
 *   2. 「不说假话」在业务失败上的那一半 —— 需要一次 payload.error 有值的结果。
 *      R11 删掉了 failForTest,模型够不着这条路径,只能靠临时注入异常制造。
 * 两条不变量本身是对的、成本也低,但它们现在的状态是「装着,没验过」。
 * 采到对应形状的夹具之前,别把它们算作已验证的防线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { replay } from './harness.mjs'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/session-full-chain.json', import.meta.url)), 'utf8'),
)
/** @type {any[]} */
const EVENTS = fixture.events

const isMetaBoardCall = (/** @type {any} */ e) =>
  e.type === 'tool/call' && String(e.data?.name ?? '').startsWith('metaboard_')

/** 日志里每一次 metaboard 调用:callId → { 工具名, 结果事件 }。 */
function callsFromLog() {
  /** @type {Map<string, { tool: string, result: any }>} */
  const calls = new Map()
  for (const e of EVENTS) {
    if (isMetaBoardCall(e)) calls.set(String(e.data.callId), { tool: e.data.name, result: undefined })
  }
  for (const e of EVENTS) {
    if (e.type !== 'tool/result') continue
    const id = String(e.data?.message?.content?.[0]?.toolCallId ?? '')
    const entry = calls.get(id)
    if (entry) entry.result = e
  }
  return calls
}

/**
 * 这次调用到底成没成 —— 直接从日志推,不看账本怎么说。
 *
 * 这是一份独立推导,故意和 callDefinition.update 各写一遍:对账的价值就在于
 * 两条路径独立得出同一个结论。抄过来就变成了自己证明自己。
 */
function outcomeFromLog(/** @type {any} */ result) {
  if (result === undefined) return 'running'
  const d = result.data ?? {}
  const block = d.message?.content?.[0]
  if (d.error !== undefined) return 'failed'
  if (block?.isError === true) return 'failed'
  if (d.meta?.payload?.error !== undefined) return 'failed'
  return 'done'
}

const REPLAY = replay(EVENTS)

/**
 * 账本上可见的行,按 key 关联回快照节点,拿到它的 kind 与 id。
 *
 * 用 key 关联而不是解析 key 的格式:key 由装配器拼(实测形如
 * `14:metaboard-callcall_00_xxx`),格式是它的内部约定,测试去解析等于把
 * 一个不属于自己的约定钉死。关联只依赖「两边是同一个 key」这一点。
 */
function visibleRows() {
  const byKey = new Map(REPLAY.snapshot.rows.map((/** @type {any} */ r) => [r.key, r]))
  return REPLAY.entries.map((e) => {
    const node = byKey.get(e.key)
    assert.ok(node !== undefined, `渲染出的行 ${e.key} 在快照里找不到对应节点`)
    return { key: e.key, text: e.text, kind: node.kind, id: String(node.id) }
  })
}

test('夹具本身是真的:含成功链路、一次成功评审、一次参数校验失败的评审', () => {
  const calls = callsFromLog()
  assert.ok(calls.size >= 5, `metaboard 调用太少(${calls.size}),夹具没覆盖到该覆盖的形状`)
  const outcomes = [...calls.values()].map((c) => outcomeFromLog(c.result))
  assert.ok(outcomes.includes('done'), '夹具里没有成功的调用')
  assert.ok(outcomes.includes('failed'), '夹具里没有失败的调用')
  // 参数校验失败的形状:没有 meta,没有 data.error,失败只写在内容块的 isError 上。
  const argsError = EVENTS.some((e) =>
    e.type === 'tool/result' && e.data?.meta === undefined && e.data?.error === undefined
    && e.data?.message?.content?.[0]?.isError === true)
  assert.ok(argsError, '夹具里没有参数校验失败的结果 —— 那正是缝最多的一条路径')
  // 评审消息必须带 callId:显式关联是「抑制取决于评审行在不在」的前提。
  const reviewMsg = EVENTS.find((e) => e.type === 'user/message' && e.data?.source?.plugin === 'metaboard')
  assert.ok(reviewMsg !== undefined, '夹具里没有评审消息')
  assert.ok(reviewMsg.data.source.callId !== undefined, '评审消息没带 callId')
})

// ─────────────────────────── 对账规则 ───────────────────────────

test('守恒:日志里每一次 metaboard 调用,账本上都有交代', () => {
  const calls = callsFromLog()
  // 账本上可见的调用行 —— 节点与 id 都由生产代码产出,不是测试拼的。
  const visible = new Set(visibleRows().filter((r) => r.kind === 'metaboard-call').map((r) => r.id))
  // 被评审行代表的调用:评审行自己说了它出自哪次调用。
  const reviewed = new Set(
    REPLAY.snapshot.rows
      .filter((/** @type {any} */ r) => r.kind === 'metaboard-review')
      .map((/** @type {any} */ r) => r.data?.callId)
      .filter((/** @type {any} */ id) => id !== undefined),
  )
  const vanished = [...calls.entries()]
    .filter(([id]) => !visible.has(id) && !reviewed.has(id))
    .map(([id, c]) => `${c.tool}(${id})`)
  assert.deepEqual(vanished, [], `这些调用在日志里发生了,账本上一行都没有:\n  ${vanished.join('\n  ')}`)
})

test('不说假话:账本上的 status,和从日志独立推出来的成败一致', () => {
  const calls = callsFromLog()
  /** @type {string[]} */
  const lies = []
  for (const [id, c] of calls) {
    const row = visibleRows().find((r) => r.kind === 'metaboard-call' && r.id === id)
    if (row === undefined) continue // 被评审行代表了,守恒那条已经管住
    const expected = outcomeFromLog(c.result)
    const shown = /·\s+(running|done|failed)\s+·/.exec(row.text)?.[1]
    if (shown !== expected) lies.push(`${c.tool}(${id}):日志说 ${expected},账本显示 ${shown}`)
  }
  assert.deepEqual(lies, [], `账本和日志对不上:\n  ${lies.join('\n  ')}`)
})

test('不显示 undefined:渲染出的任何一行都不含字面量 undefined', () => {
  const bad = REPLAY.entries.filter((r) => r.text.includes('undefined'))
  assert.deepEqual(bad.map((r) => r.key), [], `这些行渲染出了 undefined:\n${bad.map((r) => r.text).join('\n---\n')}`)
})

// 这条比「要么解析要么标未解析」更严:整个会话都在窗口里,引用的目标又确实在
// 日志里,那它就必须解析出来。显示成「未解析」在这种情况下不是诚实,是错的 ——
// R18 那个缺陷正是这样:被引用的节点在数据层被丢弃,引用不是「尚未加载」,
// 而是结构上永远不可能解析,可它看起来和一次正常的窗口缺口一模一样。
test('引用必须解析:全量重放时,指向日志中已存在调用的 derivedFrom 不允许显示成未解析', () => {
  const known = new Set([...callsFromLog().keys()])
  /** @type {string[]} */
  const broken = []
  for (const e of EVENTS) {
    if (e.type !== 'tool/result') continue
    const from = e.data?.meta?.derivedFrom
    if (!Array.isArray(from) || from.length === 0) continue
    const id = String(e.data.message.content[0].toolCallId)
    const row = visibleRows().find((r) => r.kind === 'metaboard-call' && r.id === id)
    if (row === undefined) continue
    for (const ref of from) {
      if (!known.has(String(ref))) continue // 目标不在日志里,未解析是诚实的
      if (row.text.includes(`${ref}(未解析)`)) {
        broken.push(`${id} 的 derivedFrom ${ref}:目标在日志里,账本却显示未解析`)
      } else if (!row.text.includes(String(ref))) {
        broken.push(`${id} 的 derivedFrom ${ref} 在账本上完全没有交代`)
      }
    }
  }
  assert.deepEqual(broken, [], broken.join('\n'))
})

// ─────────────────────────── 对照文件 ───────────────────────────

test('账本重放结果与对照文件逐字一致', () => {
  const goldenPath = fileURLToPath(new URL('./fixtures/session-full-chain.ledger.txt', import.meta.url))
  // 大载荷(draft 正文)截断后再比,否则对照文件没法读;截断标记本身也参与比对。
  const actual = REPLAY.entries
    .map((r) => `${r.key}\n${r.text.length > 400 ? r.text.slice(0, 400) + '\n…[截断]' : r.text}`)
    .join('\n\n════\n\n') + '\n'
  // 更新对照文件是显式动作,不能是测试跑一遍的副作用 —— 那等于「行为一变就把
  // 期望改成新行为」,对照文件就永远是对的,也永远没用。
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, actual)
  const expected = readFileSync(goldenPath, 'utf8')
  assert.equal(actual, expected, '账本渲染结果变了。确认这是你要的改动后,用 UPDATE_GOLDEN=1 npm test 更新对照文件。')
})
