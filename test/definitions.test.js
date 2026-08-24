// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// fileURLToPath 而非 new URL(...).pathname:后者不做百分号解码,检出路径里只要有
// 空格或非 ASCII(例如放在 ~/Library/Application Support/ 下),readFileSync 就会失败。
import { fileURLToPath } from 'node:url'
import * as cordis from '@deepseek-ai/cordis'
import { KINDS, isMetaBoardMeta, matchMetaBoardEvent } from '../lib/envelope.js'

// ─────────────────────────── matchMetaBoardEvent ───────────────────────────

test('tool/call 以 metaboard_ 开头 → start,id 是 callId', () => {
  assert.deepEqual(
    matchMetaBoardEvent({ type: 'tool/call', data: { callId: 'c1', name: 'metaboard_draft' } }),
    { id: 'c1', role: 'start' },
  )
})

test('非 metaboard 工具的 tool/call 不认领', () => {
  assert.equal(
    matchMetaBoardEvent({ type: 'tool/call', data: { callId: 'c1', name: 'bash' } }),
    null,
  )
})

test('tool/result 带信封 → update,id 取自 tool-result 块的 toolCallId', () => {
  assert.deepEqual(
    matchMetaBoardEvent({
      type: 'tool/result',
      data: {
        meta: { subject: 's', kind: 'draft', payload: {} },
        message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] },
      },
    }),
    { id: 'c1', role: 'update' },
  )
})

test('tool/result 没有信封也认领 —— 缺信封的结果必须能给 Context 收尾', () => {
  assert.deepEqual(
    matchMetaBoardEvent({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } },
    }),
    { id: 'c1', role: 'update' },
  )
})

test('首块不是 tool-result 的 tool/result 不认领', () => {
  assert.equal(
    matchMetaBoardEvent({ type: 'tool/result', data: { message: { content: [{ type: 'text' }] } } }),
    null,
  )
})

test('plugin 来源的 user/message → start,id 是事件 seq', () => {
  assert.deepEqual(
    matchMetaBoardEvent({
      type: 'user/message', seq: 8,
      data: { source: { kind: 'plugin', plugin: 'metaboard' } },
    }, 'review'),
    { id: '8', role: 'start' },
  )
})

test('普通用户输入不被评审 Definition 认领', () => {
  assert.equal(
    matchMetaBoardEvent({ type: 'user/message', seq: 8, data: { source: { kind: 'user' } } }, 'review'),
    null,
  )
})

test('别的插件写的 user/message 不被认领', () => {
  assert.equal(
    matchMetaBoardEvent({
      type: 'user/message', seq: 8,
      data: { source: { kind: 'plugin', plugin: 'other' } },
    }, 'review'),
    null,
  )
})

// ────────────────────── 把 client 半的工厂跑起来 ──────────────────────
// client.js 是浏览器工厂,没有构建步骤,node 里不能直接 import。这里补上它
// 期待的 window.__ModuleLoader__ 契约,拿到工厂真正注册的两个 Definition。

/** @param {string} path @param {Record<string, unknown>} modules */
function loadFactoryBundle(path, modules) {
  /** @type {any} */
  let captured
  // 在本 realm 里求值,不用 vm:跨 realm 的对象原型不同,assert.deepEqual 会
  // 把结构相同的结果判成不相等。
  const load = new Function('window', readFileSync(path, 'utf8') + `\n//# sourceURL=${path}`)
  load({ __ModuleLoader__: { load: (/** @type {any} */ m) => { captured = m } } })
  assert.ok(captured !== undefined, `${path} 没有调用 window.__ModuleLoader__.load`)
  return captured.factory((/** @type {string} */ id) => {
    if (!(id in modules)) throw new Error(`未打桩的 require: ${id}`)
    return modules[id]
  })
}

function loadDefinitions() {
  const half = loadFactoryBundle(fileURLToPath(new URL('../lib/client.js', import.meta.url)), {
    react: { createElement: () => null },
  })
  /** @type {any[]} */
  const registered = []
  /** @type {any[]} */
  const views = []
  /** @type {any} */
  const ctx = {
    conversationEvents: { register: (/** @type {any} */ d) => { registered.push(d); return () => {} } },
    conversationViews: { register: (/** @type {any} */ d) => { views.push(d); return () => {} } },
    slots: { inject: () => {}, register: () => () => {} },
  }
  half.apply(ctx)
  const byKind = new Map(registered.map((d) => [d.kind, d]))
  return {
    inject: half.inject,
    call: byKind.get('metaboard-call'),
    review: byKind.get('metaboard-review'),
    view: views[0],
  }
}

test('client 半注册 metaboard-call 与 metaboard-review,并声明所需服务', () => {
  const { inject, call, review } = loadDefinitions()
  // 快照走 props.useSession,ctx.sessions 在 client.js 里一次都没用到 ——
  // 这里不再把它列进来,免得一个替死配置站岗的断言。
  assert.deepEqual(inject, ['slots', 'conversationEvents', 'conversationViews'])
  assert.equal(call.target, 'metaboard')
  assert.equal(review.target, 'metaboard')
})

// 这两条等价测试挡的是「已列举形状上的行为分歧」,不是「行为等价」。
// 边界要说清楚:下面的事件表是手写的 16 条形状,kind 表由 KINDS 派生。
// KINDS 那一半是双向的 —— 任一半加了 kind 而另一半没跟上,立刻红。
// 事件表这一半是单向的 —— 只往 client.js 加一个 match 分支、envelope.js 没有
// 对应形状进表,两边跑同一张旧表照样全绿。新增 match 分支时必须手工往表里加行。
test('client 半内联的 match 与 envelope.js 在整张行为表上一致', () => {
  const { call, review } = loadDefinitions()
  const events = [
    { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'metaboard_research' } },
    { type: 'tool/call', seq: 2, data: { callId: 'c2', name: 'metaboard_draft' } },
    { type: 'tool/call', seq: 3, data: { callId: 'c3', name: 'metaboard_revise' } },
    { type: 'tool/call', seq: 4, data: { callId: 'c4', name: 'metaboard_review' } },
    { type: 'tool/call', seq: 5, data: { callId: 'c5', name: 'bash' } },
    { type: 'tool/call', seq: 6, data: { callId: 'c6', name: 'metaboard' } },
    { type: 'tool/call', seq: 7, data: { callId: 'c7' } },
    {
      type: 'tool/result', seq: 8,
      data: {
        meta: { subject: 's', kind: 'draft', payload: {} },
        message: { content: [{ type: 'tool-result', toolCallId: 'c2' }] },
      },
    },
    { type: 'tool/result', seq: 9, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c5' }] } } },
    { type: 'tool/result', seq: 10, data: { message: { content: [{ type: 'text' }] } } },
    { type: 'tool/result', seq: 11, data: {} },
    { type: 'user/message', seq: 12, data: { source: { kind: 'plugin', plugin: 'metaboard' } } },
    { type: 'user/message', seq: 13, data: { source: { kind: 'plugin', plugin: 'other' } } },
    { type: 'user/message', seq: 14, data: { source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 15, data: {} },
    { type: 'turn/start', seq: 16, data: { turn: 1 } },
  ]
  for (const event of events) {
    assert.deepEqual(call.match(event), matchMetaBoardEvent(event, 'call'), `call: seq ${event.seq}`)
    assert.deepEqual(review.match(event), matchMetaBoardEvent(event, 'review'), `review: seq ${event.seq}`)
  }
})

test('client 半内联的信封判据与 envelope.js 一致,逐个 kind 比对', () => {
  const { call } = loadDefinitions()
  // 表从 KINDS 生成,不写死:envelope.js 加了 kind 而 client.js 漏了同步,
  // 这里立刻红。写死字面量的版本会一起漏,那正是最可能发生的一次编辑。
  const metas = [
    ...KINDS.map((kind) => ({ subject: 's', kind, payload: {} })),
    { subject: 's', kind: 'nonesuch', payload: {} },
    { subject: 's', kind: 'draft', payload: null },
    { subject: 's', kind: 'draft', payload: 0 },
    { subject: 42, kind: 'draft', payload: {} },
    { subject: 's', kind: 'draft' },
    { kind: 'draft', payload: {} },
    null, undefined, 'draft', 7,
  ]
  for (const meta of metas) {
    const match = { event: { time: 1, data: resultData('c1', { meta }) } }
    const next = call.update({ state: { status: 'running' } }, match)
    assert.equal(
      'contentKind' in next, isMetaBoardMeta(meta),
      `信封判据分歧: ${JSON.stringify(meta)}`,
    )
  }
})

test('业务失败没有传输错误,status 仍然是 failed', () => {
  const { call } = loadDefinitions()
  const meta = { subject: 's', kind: 'revise', payload: { added: 0, removed: 0, error: 'boom' } }
  const next = call.update(
    { state: { status: 'running' } },
    { event: { time: 1, data: resultData('c1', { meta }) } },
  )
  assert.equal(next.status, 'failed')
  assert.equal(next.payload.error, 'boom')
})

test('业务成功且没有传输错误,status 是 done', () => {
  const { call } = loadDefinitions()
  const meta = { subject: 's', kind: 'revise', payload: { added: 3, removed: 1 } }
  const next = call.update(
    { state: { status: 'running' } },
    { event: { time: 1, data: resultData('c1', { meta }) } },
  )
  assert.equal(next.status, 'done')
})

// ────────────────────── view builder:buildSnapshot ──────────────────────
// buildSnapshot 不对外导出(工厂形态没有构建步骤),这里通过
// ctx.conversationViews.register 捕获真正注册的 ConversationViewDefinition,
// 经它 create() 出的 builder 的 replace/apply 验证行为——接口与
// packages/client/runtime 的 ConversationViewBuilder 一致。

const TIMELINE = { turnOrder: [], turns: new Map() }

test('view builder 注册在 target metaboard 上', () => {
  const { view } = loadDefinitions()
  assert.equal(view.target, 'metaboard')
})

test('buildSnapshot: 已加载的引用解析为 resolved,带目标的 kind 与 tool', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const researchNode = {
    key: 'metaboard-call:c1', kind: 'metaboard-call', id: 'c1', target: 'metaboard',
    data: {
      callId: 'c1', tool: 'metaboard_research', turn: 1, step: 1, startedAt: 1, endedAt: 2,
      status: 'done', subject: 'topic:x', contentKind: 'research', derivedFrom: [], payload: {},
    },
  }
  const draftNode = {
    key: 'metaboard-call:c2', kind: 'metaboard-call', id: 'c2', target: 'metaboard',
    data: {
      callId: 'c2', tool: 'metaboard_draft', turn: 1, step: 2, startedAt: 3, endedAt: 4,
      status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: ['c1'], payload: {},
    },
  }
  const snapshot = builder.replace({ nodes: [researchNode, draftNode], timeline: TIMELINE })
  const draftRow = snapshot.rows.find((/** @type {any} */ r) => r.id === 'c2')
  assert.deepEqual(draftRow.refs, [{ id: 'c1', resolved: true, kind: 'research', tool: 'metaboard_research' }])
})

test('buildSnapshot: 目标不在当前节点集里的引用降级为 unresolved,不抛错、不丢行', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const draftNode = {
    key: 'metaboard-call:c2', kind: 'metaboard-call', id: 'c2', target: 'metaboard',
    data: {
      callId: 'c2', tool: 'metaboard_draft', turn: 1, step: 2, startedAt: 3, endedAt: 4,
      status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: ['c1'], payload: {},
    },
  }
  const snapshot = builder.replace({ nodes: [draftNode], timeline: TIMELINE })
  assert.equal(snapshot.rows.length, 1)
  assert.deepEqual(snapshot.rows[0].refs, [{ id: 'c1', resolved: false }])
})

test('buildSnapshot: 没有信封的行(contentKind undefined)不崩溃、不丢行,refs 为空数组', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const bareNode = {
    key: 'metaboard-call:c3', kind: 'metaboard-call', id: 'c3', target: 'metaboard',
    // 参数校验失败 / 子派发 / 崩溃补齐三条路径产出的行:只有 callId/tool/turn/step/
    // startedAt/status/endedAt,没有 subject/contentKind/derivedFrom/payload。
    data: { callId: 'c3', tool: 'metaboard_draft', turn: 1, step: 1, startedAt: 1, endedAt: 2, status: 'failed' },
  }
  const snapshot = builder.replace({ nodes: [bareNode], timeline: TIMELINE })
  assert.equal(snapshot.rows.length, 1)
  assert.deepEqual(snapshot.rows[0].refs, [])
  assert.equal('contentKind' in snapshot.rows[0].data, false)
})

test('buildSnapshot: bySubject 按 subject 分组,没有 subject 的行(缺信封 / 评审)被跳过', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const researchNode = {
    key: 'k1', kind: 'metaboard-call', id: 'c1', target: 'metaboard',
    data: { callId: 'c1', tool: 'metaboard_research', status: 'done', subject: 'topic:x', contentKind: 'research', derivedFrom: [], payload: {} },
  }
  const draftNode = {
    key: 'k2', kind: 'metaboard-call', id: 'c2', target: 'metaboard',
    data: { callId: 'c2', tool: 'metaboard_draft', status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: ['c1'], payload: {} },
  }
  const otherSubjectNode = {
    key: 'k3', kind: 'metaboard-call', id: 'c4', target: 'metaboard',
    data: { callId: 'c4', tool: 'metaboard_research', status: 'done', subject: 'topic:y', contentKind: 'research', derivedFrom: [], payload: {} },
  }
  const bareNode = {
    key: 'k4', kind: 'metaboard-call', id: 'c3', target: 'metaboard',
    data: { callId: 'c3', tool: 'metaboard_draft', status: 'failed' },
  }
  const reviewNode = {
    key: 'k5', kind: 'metaboard-review', id: '9', target: 'metaboard',
    data: { seq: 9, at: 1, summary: 's', text: 't' },
  }
  const snapshot = builder.replace({
    nodes: [researchNode, draftNode, otherSubjectNode, bareNode, reviewNode],
    timeline: TIMELINE,
  })
  assert.deepEqual(snapshot.bySubject, { 'topic:x': ['c1', 'c2'], 'topic:y': ['c4'] })
})

test('buildSnapshot: apply 增量追加后,之前 unresolved 的引用重新解析', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const draftNode = {
    key: 'k2', kind: 'metaboard-call', id: 'c2', target: 'metaboard',
    data: { callId: 'c2', tool: 'metaboard_draft', status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: ['c1'], payload: {} },
  }
  const first = builder.replace({ nodes: [draftNode], timeline: TIMELINE })
  assert.deepEqual(first.rows[0].refs, [{ id: 'c1', resolved: false }])

  const researchNode = {
    key: 'k1', kind: 'metaboard-call', id: 'c1', target: 'metaboard',
    data: { callId: 'c1', tool: 'metaboard_research', status: 'done', subject: 'topic:x', contentKind: 'research', derivedFrom: [], payload: {} },
  }
  const second = builder.apply({ upserts: [researchNode], timeline: TIMELINE })
  const row = second.rows.find((/** @type {any} */ r) => r.id === 'c2')
  assert.deepEqual(row.refs, [{ id: 'c1', resolved: true, kind: 'research', tool: 'metaboard_research' }])
})

// R18:revise 对 review 的引用曾经结构性地永远无法解析 —— metaboard_review 的
// 工具调用节点被 buildViewNode 抑制成 null,从不到达 buildSnapshot,它的 callId
// 永远进不了 byCall 索引。修法是抑制挪到呈现层(referenceOnly 标记),节点照常产出。
// 这里用 buildSnapshot 收到的节点形状直接钉住:review 的工具调用节点存在、
// 带 referenceOnly: true,revise 对它的引用能解析。

test('buildSnapshot: revise 对 review 的引用现在能解析(R18),review 的工具调用行标记 referenceOnly 但仍在 rows 里', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const reviewCallNode = {
    key: 'k-review', kind: 'metaboard-call', id: 'rc1', target: 'metaboard',
    data: {
      callId: 'rc1', tool: 'metaboard_review', status: 'done', subject: 'topic:x',
      contentKind: 'review', derivedFrom: [], payload: { decision: 'reject' }, referenceOnly: true,
    },
  }
  const reviseNode = {
    key: 'k-revise', kind: 'metaboard-call', id: 'rv1', target: 'metaboard',
    data: {
      callId: 'rv1', tool: 'metaboard_revise', status: 'done', subject: 'topic:x',
      contentKind: 'revise', derivedFrom: ['rc1'], payload: {}, referenceOnly: false,
    },
  }
  const snapshot = builder.replace({ nodes: [reviewCallNode, reviseNode], timeline: TIMELINE })
  assert.equal(snapshot.rows.length, 2)
  const reviewRow = snapshot.rows.find((/** @type {any} */ r) => r.id === 'rc1')
  assert.equal(reviewRow.data.referenceOnly, true)
  const reviseRow = snapshot.rows.find((/** @type {any} */ r) => r.id === 'rv1')
  assert.deepEqual(reviseRow.refs, [{ id: 'rc1', resolved: true, kind: 'review', tool: 'metaboard_review' }])
})

test('buildSnapshot: 真正不在节点集里的引用仍然是 unresolved —— 这次修复没有让一切都变成 resolved', () => {
  const { view } = loadDefinitions()
  const builder = view.create()
  const reviseNode = {
    key: 'k-revise', kind: 'metaboard-call', id: 'rv1', target: 'metaboard',
    data: {
      callId: 'rv1', tool: 'metaboard_revise', status: 'done', subject: 'topic:x',
      contentKind: 'revise', derivedFrom: ['nonexistent'], payload: {}, referenceOnly: false,
    },
  }
  const snapshot = builder.replace({ nodes: [reviseNode], timeline: TIMELINE })
  assert.deepEqual(snapshot.rows[0].refs, [{ id: 'nonexistent', resolved: false }])
})

// ───────────────── 真装配器:两个 Definition 装得起来吗 ─────────────────

function loadAssembler() {
  const runtime = loadFactoryBundle(
    fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js', import.meta.url)),
    {
      '@deepseek-ai/cordis': cordis,
      // 装配器不碰它,给个不会在求值期抛的桩就够了
      '@deepseek-ai/dsh-client-ui-slots': new Proxy({}, { get: () => class {} }),
    },
  )
  return runtime.ConversationNodeAssembler
}

/** 把两个 Definition 接上真装配器,外加一个只收集节点的 view builder。 */
function harness() {
  const Assembler = loadAssembler()
  const { call, review } = loadDefinitions()
  /** @type {Map<string, any>} */
  const nodes = new Map()
  const views = {
    entries: () => [{
      target: 'metaboard',
      create: () => ({
        empty: [],
        replace: (/** @type {any} */ input) => {
          nodes.clear()
          for (const node of input.nodes) nodes.set(node.key, node)
          return [...nodes.values()]
        },
        apply: (/** @type {any} */ input) => {
          for (const node of input.upserts) nodes.set(node.key, node)
          return [...nodes.values()]
        },
      }),
    }],
  }
  const events = { entries: () => [call, review], fallbackEntry: () => undefined }
  const asm = new Assembler(events, views)
  asm.replaceWindow([], false)
  asm.flush()
  return { asm, nodes, data: () => [...nodes.values()].map((n) => ({ kind: n.kind, ...n.data })) }
}

let seq = 0
const wrap = (/** @type {string} */ type, /** @type {any} */ data) =>
  ({ event: { seq: ++seq, type, time: 1000 + seq, data }, view: undefined })
const toolCall = (/** @type {string} */ name, /** @type {string} */ callId) =>
  wrap('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
/**
 * 真实形状的 tool/result 事件 data —— 唯一的形状权威,别处不再手写。
 *
 * 失败有两个互相独立的落点:dsh-tools 的 toolErrorResult 只在 result.error?.info
 * 存在时才写出 data.error(lib/index.js:3483 的 `...info ? { info } : {}`),
 * 而 ToolArgsError 没有 info,于是参数校验失败的事件根本没有 data.error,
 * 只有 message 内容块上的 isError: true。会话日志实测的原始事件见
 * docs/phase-1-acceptance.md「意外发现」第 1 条(seq 2428)。
 */
const resultData = (
  /** @type {string} */ callId,
  /** @type {{ meta?: any, error?: any, isError?: boolean, text?: string }} */ options = {},
) => ({
  turn: 1, step: 1,
  message: {
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result', toolCallId: callId,
      content: [{ type: 'text', text: options.text ?? 'ok' }],
      isError: options.isError ?? false,
    }],
  },
  ...(options.meta === undefined ? {} : { meta: options.meta }),
  ...(options.error === undefined ? {} : { error: options.error }),
})
const toolResult = (/** @type {string} */ callId, /** @type {any} */ meta = undefined, /** @type {any} */ error = undefined) =>
  wrap('tool/result', resultData(callId, { meta, error }))
/** 参数校验失败的结果:没有 meta、没有 data.error,失败只写在内容块的 isError 上。 */
const argsErrorResult = (/** @type {string} */ callId) =>
  wrap('tool/result', resultData(callId, {
    isError: true, text: 'Error: invalid arguments: missing required property "notes"',
  }))
/**
 * 评审工具写进对话的那条消息。source.callId 是 lib/tools/review.js 真实写出的字段 ——
 * 它把「这条评审出自哪次调用」写成数据,渲染层据此判断评审行是否存在。
 * @param {string} [callId]
 */
const reviewMessage = (callId = 'r1') => wrap('user/message', {
  role: 'user',
  content: [{ type: 'text', text: '[人工评审 · reject] 开头太平' }],
  source: {
    kind: 'plugin', plugin: 'metaboard', form: 'notice',
    summary: '人工评审 · 打回', callId,
  },
})

const DRAFT_META = { subject: 'topic:x', kind: 'draft', derivedFrom: ['c1'], payload: { title: '标题' } }
const REVIEW_META = { subject: 'topic:x', kind: 'review', payload: { decision: 'reject' } }

test('装配器接受两个 Definition:一次带信封的调用装出一行', () => {
  const h = harness()
  h.asm.append(toolCall('metaboard_draft', 'd1'))
  h.asm.flush()
  h.asm.append(toolResult('d1', DRAFT_META))
  h.asm.flush()
  assert.deepEqual(h.data(), [{
    kind: 'metaboard-call', callId: 'd1', tool: 'metaboard_draft', turn: 1, step: 1,
    startedAt: h.data()[0].startedAt, status: 'done', endedAt: h.data()[0].endedAt,
    subject: 'topic:x', contentKind: 'draft', derivedFrom: ['c1'], payload: { title: '标题' },
    referenceOnly: false,
  }])
})

test('参数校验失败(缺信封)收尾为 failed —— 失败信号只在 isError 上(R19)', () => {
  // 这个测试此前用的是 { error: { name: 'ToolArgsError' } } 这种系统从不产出的
  // 形状,于是它一直是绿的,而真实会话里这一行被标成 done。现在用实测形状:
  // 没有 meta、没有 data.error,只有内容块上的 isError。
  const h = harness()
  h.asm.append(toolCall('metaboard_draft', 'd2'))
  h.asm.flush()
  h.asm.append(argsErrorResult('d2'))
  h.asm.flush()
  const row = h.data()[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.contentKind, undefined)
})

test('带信封但内容块 isError 的结果也是 failed(R19)', () => {
  const h = harness()
  h.asm.append(toolCall('metaboard_draft', 'd4'))
  h.asm.flush()
  h.asm.append(wrap('tool/result', resultData('d4', { meta: DRAFT_META, isError: true })))
  h.asm.flush()
  assert.equal(h.data()[0].status, 'failed')
})

test('带 data.error 的结果仍然是 failed —— R19 只是加宽证据,没有换掉证据', () => {
  const h = harness()
  h.asm.append(toolCall('metaboard_draft', 'd5'))
  h.asm.flush()
  h.asm.append(toolResult('d5', undefined, { name: 'ToolExecutionError', info: { code: 'X' } }))
  h.asm.flush()
  assert.equal(h.data()[0].status, 'failed')
})

test('别的工具的 tool/result 被认领但不产出任何节点', () => {
  const h = harness()
  h.asm.append(toolCall('bash', 'b1'))
  h.asm.flush()
  h.asm.append(toolResult('b1', undefined))
  h.asm.flush()
  assert.deepEqual(h.data(), [])
})

test('人工评审的可见行来自 user/message;工具调用行照常产出,但标记 referenceOnly(R18)', () => {
  const h = harness()
  h.asm.append(toolCall('metaboard_review', 'r1'))
  h.asm.flush()
  h.asm.append(toolResult('r1', REVIEW_META))
  h.asm.flush()
  h.asm.append(reviewMessage())
  h.asm.flush()
  const rows = h.data()
  assert.equal(rows.length, 2)
  const call = rows.find((r) => r.kind === 'metaboard-call')
  const review = rows.find((r) => r.kind === 'metaboard-review')
  assert.equal(call.callId, 'r1')
  assert.equal(call.contentKind, 'review')
  assert.equal(call.referenceOnly, true)
  assert.equal(review.summary, '人工评审 · 打回')
  assert.equal(review.text, '[人工评审 · reject] 开头太平')
})

test('先只装到 tool/result,再补回更早的 tool/call,行会被重放补全', () => {
  const h = harness()
  const start = toolCall('metaboard_draft', 'd3')
  const end = toolResult('d3', DRAFT_META)
  h.asm.replaceWindow([end], true)
  h.asm.flush()
  assert.deepEqual(h.data(), [])
  h.asm.prepend([start], false)
  h.asm.flush()
  const row = h.data()[0]
  assert.equal(row.tool, 'metaboard_draft')
  assert.equal(row.status, 'done')
  assert.equal(row.contentKind, 'draft')
})

// R18 端到端回归:真装配器 + 真正注册的 view builder(不是 harness() 那个只收集
// 节点的桩),把 draft → review → revise 整条链跑一遍,钉住 revise 对 review 的
// 引用现在能解析 —— 这正是原来结构性地永远解析不了的那条链。

/** 把两个 Definition 接上真装配器,view 端用真正注册的 ConversationViewDefinition
 * (而不是 harness() 里那个只收集节点的桩),这样 buildSnapshot 真的跑起来。 */
function harnessWithRealView() {
  const Assembler = loadAssembler()
  const { call, review, view } = loadDefinitions()
  const builder = view.create()
  let snapshot = builder.empty
  const views = {
    entries: () => [{
      target: 'metaboard',
      create: () => ({
        empty: builder.empty,
        replace: (/** @type {any} */ input) => { snapshot = builder.replace(input); return snapshot },
        apply: (/** @type {any} */ input) => { snapshot = builder.apply(input); return snapshot },
      }),
    }],
  }
  const events = { entries: () => [call, review], fallbackEntry: () => undefined }
  const asm = new Assembler(events, views)
  asm.replaceWindow([], false)
  asm.flush()
  return { asm, snapshot: () => snapshot }
}

test('真装配器 + 真 view builder:revise 对 review 的引用端到端解析(R18 回归)', () => {
  const h = harnessWithRealView()
  h.asm.append(toolCall('metaboard_draft', 'd1'))
  h.asm.flush()
  h.asm.append(toolResult('d1', DRAFT_META))
  h.asm.flush()
  h.asm.append(toolCall('metaboard_review', 'r1'))
  h.asm.flush()
  h.asm.append(toolResult('r1', REVIEW_META))
  h.asm.flush()
  h.asm.append(reviewMessage())
  h.asm.flush()
  const REVISE_META = { subject: 'topic:x', kind: 'revise', derivedFrom: ['d1', 'r1'], payload: { added: 1, removed: 1 } }
  h.asm.append(toolCall('metaboard_revise', 'v1'))
  h.asm.flush()
  h.asm.append(toolResult('v1', REVISE_META))
  h.asm.flush()

  const snapshot = h.snapshot()
  const reviseRow = snapshot.rows.find((/** @type {any} */ r) => r.id === 'v1')
  assert.deepEqual(reviseRow.refs, [
    { id: 'd1', resolved: true, kind: 'draft', tool: 'metaboard_draft' },
    { id: 'r1', resolved: true, kind: 'review', tool: 'metaboard_review' },
  ])
  const reviewCallRow = snapshot.rows.find((/** @type {any} */ r) => r.id === 'r1' && r.kind === 'metaboard-call')
  assert.equal(reviewCallRow.data.referenceOnly, true)
  const reviewMessageRow = snapshot.rows.find((/** @type {any} */ r) => r.kind === 'metaboard-review')
  assert.equal(reviewMessageRow.data.summary, '人工评审 · 打回')
})

// ─────────────────────────── 行表渲染 ───────────────────────────
// 行表逻辑不对外导出(工厂形态没有构建步骤),这里通过 ctx.slots.register 捕获
// 真正注册进 conversation.view 的那个组件,用一份把 createElement 记下来的
// react 桩渲染它 —— 断言跑的是生产路径,不是我复述的一份形状。

/** 捕获注册进 conversation.view 的组件,react.createElement 记成朴素对象。 */
function loadLedgerView() {
  const half = loadFactoryBundle(fileURLToPath(new URL('../lib/client.js', import.meta.url)), {
    react: {
      createElement: (/** @type {any} */ type, /** @type {any} */ props, /** @type {any[]} */ ...children) =>
        ({ type, props, children }),
    },
  })
  /** @type {any} */
  let component
  /** @type {any} */
  const ctx = {
    conversationEvents: { register: () => () => {} },
    conversationViews: { register: () => () => {} },
    slots: {
      inject: (/** @type {string} */ _name, /** @type {() => void} */ fn) => { fn() },
      register: (/** @type {any} */ _spec, /** @type {any} */ comp) => { component = comp; return () => {} },
    },
  }
  half.apply(ctx)
  assert.ok(component !== undefined, 'conversation.view 没有注册组件')
  return component
}

/** 用一份快照渲染行表,返回渲染树。 */
function render(/** @type {any} */ snapshot) {
  const View = loadLedgerView()
  return View({
    useSession: (/** @type {(s: any) => any} */ select) =>
      select({ views: new Map([['metaboard', snapshot]]) }),
  })
}

/** 渲染树里的全部文本,按出现顺序。 */
function textOf(/** @type {any} */ node) {
  if (node === null || node === undefined || node === false) return []
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (typeof node === 'string') return [node]
  if (typeof node === 'object' && 'children' in node) return textOf(node.children)
  return [String(node)]
}

/** 行表里的每一行,渲染成一段文本。 */
function renderedRows(/** @type {any} */ snapshot) {
  /** @type {any[]} */
  const rows = []
  const walk = (/** @type {any} */ n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n === null || typeof n !== 'object' || !('children' in n)) return
    if (n.props && n.props.key !== undefined) rows.push(textOf(n).join('\n'))
    else walk(n.children)
  }
  walk(render(snapshot))
  return rows
}

/** @param {any} data @param {any[]} [refs] */
const callRow = (data, refs = []) => ({
  key: 'metaboard-call:' + data.callId, kind: 'metaboard-call', id: data.callId,
  target: 'metaboard', refs, data,
})

const DONE_DRAFT = callRow({
  callId: 'd1', tool: 'metaboard_draft', turn: 2, step: 5, startedAt: 1, endedAt: 2,
  status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: [],
  payload: { charCount: 12 }, referenceOnly: false,
})

test('行表:空快照渲染成空态而不是崩溃', () => {
  assert.deepEqual(renderedRows({ rows: [], bySubject: {} }), [])
  assert.deepEqual(textOf(render({ rows: [], bySubject: {} })), ['本会话还没有 MetaBoard 记录'])
  // 视图还没建起来时 views.get 返回 undefined,同样不能崩。
  assert.deepEqual(textOf(render(undefined)), ['本会话还没有 MetaBoard 记录'])
})

test('行表:调用行显示工具名、status、turn 与 step(判据 3 的三层)', () => {
  const [row] = renderedRows({ rows: [DONE_DRAFT], bySubject: {} })
  assert.match(row, /metaboard_draft/)
  assert.match(row, /done/)
  assert.match(row, /turn 2 \/ step 5/)
  assert.match(row, /"charCount": 12/)
})

test('行表:status 直接显示,不从 payload.error 重新推导', () => {
  const failed = callRow({
    callId: 'v1', tool: 'metaboard_revise', turn: 1, step: 1, startedAt: 1, endedAt: 2,
    status: 'failed', subject: 'topic:x', contentKind: 'revise', derivedFrom: [],
    payload: { added: 0, removed: 0, error: 'boom' }, referenceOnly: false,
  })
  const [row] = renderedRows({ rows: [failed], bySubject: {} })
  assert.match(row, /metaboard_revise\s+·\s+failed/)
  assert.match(row, /"error": "boom"/)
})

test('行表:referenceOnly 的行不显示 —— 一次评审只出一行', () => {
  const reviewCall = callRow({
    callId: 'r1', tool: 'metaboard_review', turn: 1, step: 1, startedAt: 1, endedAt: 2,
    status: 'done', subject: 'topic:x', contentKind: 'review', derivedFrom: [],
    payload: { decision: 'reject' }, referenceOnly: true,
  })
  const reviewMsg = {
    key: 'metaboard-review:340', kind: 'metaboard-review', id: '340', target: 'metaboard',
    data: { seq: 340, at: 3, callId: 'r1', summary: '人工评审 · 打回', text: '[人工评审 · reject] 开头太平' },
  }
  const rows = renderedRows({ rows: [reviewCall, reviewMsg], bySubject: {} })
  assert.equal(rows.length, 1)
  assert.match(rows[0], /人工评审 · 打回/)
})

// R20:抑制条件必须同时看 status。评审的可见行来自 execute 里 deferContext 写的
// user/message —— 参数校验失败时 defineTool 在 execute 之前就抛了,那条消息根本
// 不存在,调用行是这次失败在账本上唯一的痕迹。两个方向都要钉:失败的留下,成功的
// 仍然被挡。只钉一个方向的话,一个从不过滤的渲染层也能让测试通过。
test('行表:失败的评审调用行必须显示 —— 否则整次失败在账本上消失(R20)', () => {
  const failedReviewCall = callRow({
    callId: 'r9', tool: 'metaboard_review', turn: 4, step: 7, startedAt: 1, endedAt: 2,
    status: 'failed', referenceOnly: true,
  })
  // 没有配套的 user/message:deferContext 从未执行过。
  const rows = renderedRows({ rows: [failedReviewCall], bySubject: {} })
  assert.equal(rows.length, 1, '失败的评审调用行被抑制了,这次失败在账本上等于没发生')
  assert.match(rows[0], /metaboard_review\s+·\s+failed/)
  assert.match(rows[0], /turn 4 \/ step 7/)
  assert.match(rows[0], /没有信封/)
})

// 抑制的条件是「评审行确实存在」,不是「这次调用成功了」。后者只是前者的旁证 ——
// 在当前实现下碰巧等价(评审行来自 execute 里 deferContext 写的消息)。这条测试钉的是
// 前者:一个成功但评审行不存在的调用,照样必须显示。旁证版本在这一条上会漏。
test('行表:抑制取决于评审行在不在,不取决于这次调用成没成', () => {
  const doneCall = callRow({
    callId: 'r8', tool: 'metaboard_review', turn: 1, step: 1, startedAt: 1, endedAt: 2,
    status: 'done', subject: 'topic:x', contentKind: 'review', derivedFrom: [],
    payload: { decision: 'approve' }, referenceOnly: true,
  })
  const reviewRow = {
    key: 'metaboard-review:9', kind: 'metaboard-review', id: '9', target: 'metaboard',
    data: { seq: 9, at: 3, callId: 'r8', summary: '人工评审 · 通过', text: '[人工评审 · accept] 可以' },
  }

  // 评审行在 → 调用行被抑制,一次评审只出一行。
  assert.equal(renderedRows({ rows: [doneCall, reviewRow], bySubject: {} }).length, 1)

  // 评审行不在 → 调用行必须显示,哪怕这次调用是 done。
  assert.equal(renderedRows({ rows: [doneCall], bySubject: {} }).length, 1)

  // 在飞的调用同理:评审行还没产出,这一行可见。
  const running = callRow({
    callId: 'r8', tool: 'metaboard_review', turn: 1, step: 1, startedAt: 1,
    status: 'running', referenceOnly: true,
  })
  assert.equal(renderedRows({ rows: [running], bySubject: {} }).length, 1)

  // 另一次评审的行不算数 —— 按 callId 匹配,不是「有评审行就行」。
  const otherReview = {
    key: 'metaboard-review:10', kind: 'metaboard-review', id: '10', target: 'metaboard',
    data: { seq: 10, at: 4, callId: 'r-other', summary: '人工评审 · 通过', text: '别的' },
  }
  assert.equal(renderedRows({ rows: [doneCall, otherReview], bySubject: {} }).length, 2)
})

test('行表:引用的目标没有信封时退到工具名,不渲染字面量 undefined(M2)', () => {
  // 上游 research 被 run_code 子派发:调用行在,但没有信封,contentKind 是 undefined。
  const upstream = callRow({
    callId: 'u1', tool: 'metaboard_research', turn: 1, step: 1, startedAt: 1, endedAt: 2,
    status: 'done',
  })
  const downstream = callRow(
    {
      callId: 'd1', tool: 'metaboard_draft', turn: 1, step: 2, startedAt: 3, endedAt: 4,
      status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: ['u1'],
      payload: {},
    },
    [{ id: 'u1', resolved: true, kind: undefined, tool: 'metaboard_research' }],
  )
  const rows = renderedRows({ rows: [upstream, downstream], bySubject: {} })
  const drafted = rows.find((r) => /metaboard_draft/.test(r))
  assert.match(drafted, /derivedFrom: metaboard_research\(u1\)/)
  assert.doesNotMatch(drafted, /undefined/)
})

test('行表:评审行取 text,不去读它根本没有的 payload', () => {
  const reviewMsg = {
    key: 'metaboard-review:340', kind: 'metaboard-review', id: '340', target: 'metaboard',
    data: { seq: 340, at: 3, summary: '人工评审 · 打回', text: '[人工评审 · reject] 开头太平' },
  }
  const [row] = renderedRows({ rows: [reviewMsg], bySubject: {} })
  assert.match(row, /开头太平/)
  assert.doesNotMatch(row, /没有信封/)
})

test('行表:没有信封的调用行照常出现,不崩溃、不留 running', () => {
  const noEnvelope = callRow({
    callId: 'x1', tool: 'metaboard_draft', turn: 1, step: 3, startedAt: 1, endedAt: 2,
    status: 'failed', referenceOnly: false,
  })
  const [row] = renderedRows({ rows: [noEnvelope], bySubject: {} })
  assert.match(row, /metaboard_draft\s+·\s+failed/)
  assert.match(row, /turn 1 \/ step 3/)
  assert.match(row, /\(此次调用没有信封\)/)
})

test('行表:已解析的引用显示 kind,未解析的显示 id 与未解析标记', () => {
  const revise = callRow({
    callId: 'v1', tool: 'metaboard_revise', turn: 1, step: 1, startedAt: 1, endedAt: 2,
    status: 'done', subject: 'topic:x', contentKind: 'revise', derivedFrom: ['d1', 'zz'],
    payload: {}, referenceOnly: false,
  }, [
    { id: 'd1', resolved: true, kind: 'draft', tool: 'metaboard_draft' },
    { id: 'zz', resolved: false },
  ])
  const [row] = renderedRows({ rows: [revise], bySubject: {} })
  assert.match(row, /derivedFrom: draft\(d1\), zz\(未解析\)/)
})

test('行表:引用为空时不渲染 derivedFrom 那一行', () => {
  const [row] = renderedRows({ rows: [DONE_DRAFT], bySubject: {} })
  assert.doesNotMatch(row, /derivedFrom/)
})

test('行表:大载荷完整到达渲染层,不被截断', () => {
  const big = 'x'.repeat(90 * 1024)
  const draft = callRow({
    callId: 'b1', tool: 'metaboard_draft', turn: 1, step: 1, startedAt: 1, endedAt: 2,
    status: 'done', subject: 'topic:x', contentKind: 'draft', derivedFrom: [],
    payload: { draft: big }, referenceOnly: false,
  })
  const [row] = renderedRows({ rows: [draft], bySubject: {} })
  assert.ok(row.length > 90 * 1024, `渲染出的行只有 ${row.length} 字节`)
})

test('行表:快照从 useSession 的会话快照里按 views.get("metaboard") 取', () => {
  const View = loadLedgerView()
  /** @type {any[]} */
  const seen = []
  View({
    useSession: (/** @type {(s: any) => any} */ select) => {
      const snapshot = { views: new Map([['metaboard', { rows: [DONE_DRAFT], bySubject: {} }]]) }
      const picked = select(snapshot)
      seen.push(picked)
      return picked
    },
  })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].rows, [DONE_DRAFT])
})

test('真装配器 → 真 view builder → 真行表:整条链渲染成账本', () => {
  const h = harnessWithRealView()
  h.asm.append(toolCall('metaboard_draft', 'd1'))
  h.asm.flush()
  h.asm.append(toolResult('d1', DRAFT_META))
  h.asm.flush()
  h.asm.append(toolCall('metaboard_review', 'r1'))
  h.asm.flush()
  h.asm.append(toolResult('r1', REVIEW_META))
  h.asm.flush()
  h.asm.append(reviewMessage())
  h.asm.flush()
  h.asm.append(toolCall('metaboard_revise', 'v1'))
  h.asm.flush()
  h.asm.append(toolResult('v1', {
    subject: 'topic:x', kind: 'revise', derivedFrom: ['d1', 'r1'], payload: { added: 1, removed: 1 },
  }))
  h.asm.flush()

  const rows = renderedRows(h.snapshot())
  // draft、评审消息、revise 三行;review 的工具调用行被 referenceOnly 挡住。
  assert.equal(rows.length, 3)
  assert.match(rows[0], /metaboard_draft\s+·\s+done\s+·\s+turn 1 \/ step 1/)
  assert.match(rows[1], /人工评审 · 打回/)
  assert.match(rows[2], /metaboard_revise/)
  assert.match(rows[2], /derivedFrom: draft\(d1\), review\(r1\)/)
})
