// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  const half = loadFactoryBundle(new URL('../lib/client.js', import.meta.url).pathname, {
    react: { createElement: () => null },
  })
  /** @type {any[]} */
  const registered = []
  /** @type {any} */
  const ctx = {
    conversationEvents: { register: (/** @type {any} */ d) => { registered.push(d); return () => {} } },
    slots: { inject: () => {}, register: () => () => {} },
  }
  half.apply(ctx)
  const byKind = new Map(registered.map((d) => [d.kind, d]))
  return {
    inject: half.inject,
    call: byKind.get('metaboard-call'),
    review: byKind.get('metaboard-review'),
  }
}

test('client 半注册 metaboard-call 与 metaboard-review,并声明所需服务', () => {
  const { inject, call, review } = loadDefinitions()
  assert.deepEqual(inject, ['slots', 'conversationEvents', 'conversationViews', 'sessions'])
  assert.equal(call.target, 'metaboard')
  assert.equal(review.target, 'metaboard')
})

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
    const match = { event: { time: 1, data: { meta, error: undefined } } }
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
    { event: { time: 1, data: { meta, error: undefined } } },
  )
  assert.equal(next.status, 'failed')
  assert.equal(next.payload.error, 'boom')
})

test('业务成功且没有传输错误,status 是 done', () => {
  const { call } = loadDefinitions()
  const meta = { subject: 's', kind: 'revise', payload: { added: 3, removed: 1 } }
  const next = call.update(
    { state: { status: 'running' } },
    { event: { time: 1, data: { meta, error: undefined } } },
  )
  assert.equal(next.status, 'done')
})

// ───────────────── 真装配器:两个 Definition 装得起来吗 ─────────────────

function loadAssembler() {
  const runtime = loadFactoryBundle(
    new URL('../node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js', import.meta.url).pathname,
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
const toolResult = (/** @type {string} */ callId, /** @type {any} */ meta = undefined, /** @type {any} */ error = undefined) =>
  wrap('tool/result', {
    turn: 1, step: 1,
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [] }], source: { kind: 'tool' } },
    ...(meta === undefined ? {} : { meta }),
    ...(error === undefined ? {} : { error }),
  })
const reviewMessage = () => wrap('user/message', {
  role: 'user',
  content: [{ type: 'text', text: '[人工评审 · reject] 开头太平' }],
  source: { kind: 'plugin', plugin: 'metaboard', form: 'notice', summary: '人工评审 · 打回' },
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
  }])
})

test('缺信封的 tool/result 仍然给这一行收尾,不会永远停在 running', () => {
  const h = harness()
  h.asm.append(toolCall('metaboard_draft', 'd2'))
  h.asm.flush()
  h.asm.append(toolResult('d2', undefined, { name: 'ToolArgsError', code: 'TOOL_ARGS' }))
  h.asm.flush()
  const row = h.data()[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.contentKind, undefined)
})

test('别的工具的 tool/result 被认领但不产出任何节点', () => {
  const h = harness()
  h.asm.append(toolCall('bash', 'b1'))
  h.asm.flush()
  h.asm.append(toolResult('b1', undefined))
  h.asm.flush()
  assert.deepEqual(h.data(), [])
})

test('一次人工评审只出一行,来自 user/message 而不是工具调用', () => {
  const h = harness()
  h.asm.append(toolCall('metaboard_review', 'r1'))
  h.asm.flush()
  h.asm.append(toolResult('r1', REVIEW_META))
  h.asm.flush()
  h.asm.append(reviewMessage())
  h.asm.flush()
  const rows = h.data()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'metaboard-review')
  assert.equal(rows[0].summary, '人工评审 · 打回')
  assert.equal(rows[0].text, '[人工评审 · reject] 开头太平')
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
