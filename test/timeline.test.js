// @ts-check
/**
 * 两条线并成一条。这是项目立论的落点:参照项目 dashi-taskboard 有三本互不相通的账,
 * 所以看不到「改稿发生在评审打回之后、状态改成 revising 之前」。这里要能看到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTimeline, describe } from '../store/timeline.mjs'

const ts = (/** @type {number} */ m) => new Date(Date.UTC(2026, 7, 24, 10, m)).toISOString()
const ms = (/** @type {number} */ m) => Date.UTC(2026, 7, 24, 10, m)

test('按时间交错排列 —— 看板动作与工作事件在同一条线上', () => {
  const ops = [
    { ts: ts(0), actor: 'user', work: 't1', op: 'create', title: '工作项' },
    { ts: ts(20), actor: 'user', work: 't1', op: 'status', from: 'in_progress', to: 'in_review' },
    { ts: ts(55), actor: 'user', work: 't1', op: 'status', from: 'in_progress', to: 'done' },
  ]
  const work = [
    { at: ms(8), kind: 'research', payload: { count: 3, unverified: 0 } },
    { at: ms(14), kind: 'draft', payload: { charCount: 842 } },
    { at: ms(31), kind: 'review', payload: { decision: 'reject', note: '开头太平' } },
    { at: ms(52), kind: 'revise', payload: { charCount: 650 } },
  ]
  const line = mergeTimeline(ops, work)
  assert.deepEqual(line.map((e) => e.source),
    ['board', 'session', 'session', 'board', 'session', 'session', 'board'])
  // 顺序必须严格升序 —— 这是「一条线」的全部意义。
  for (let i = 1; i < line.length; i++) assert.ok(line[i].at >= line[i - 1].at)
})

test('同一毫秒:看板动作排在工作事件前面(呈现选择,已在注释里声明)', () => {
  const line = mergeTimeline(
    [{ ts: ts(5), actor: 'user', work: 't1', op: 'status', from: 'backlog', to: 'in_progress' }],
    [{ at: ms(5), kind: 'draft', payload: { charCount: 10 } }])
  assert.deepEqual(line.map((e) => e.source), ['board', 'session'])
})

test('describe:认识的 kind 说具体的', () => {
  assert.match(describe({ source: 'session', kind: 'research', payload: { count: 3, unverified: 1 } }), /素材 3 条.*1 条无出处/)
  assert.match(describe({ source: 'session', kind: 'draft', payload: { charCount: 842 } }), /842 字/)
  assert.match(describe({ source: 'session', kind: 'review', payload: { decision: 'reject', note: '开头太平' } }), /打回：开头太平/)
  assert.match(describe({ source: 'session', kind: 'revise', payload: { charCount: 650 } }), /改到 650 字/)
  assert.match(describe({ source: 'board', op: 'status', from: 'backlog', to: 'in_progress' }), /backlog → in_progress/)
  assert.match(describe({ source: 'board', op: 'archive' }), /归档/)
})

test('describe:失败要显示成失败,不能被 kind 的正常措辞盖住', () => {
  const text = describe({ source: 'session', kind: 'revise', payload: { charCount: 0, error: 'unknown topic: t999' } })
  assert.match(text, /失败/)
  assert.match(text, /t999/)
  assert.doesNotMatch(text, /改到 0 字/, '失败的调用不该被说成一次正常的改稿')
})

test('describe:不认识的 kind 只报 kind,不瞎说', () => {
  assert.equal(describe({ source: 'session', kind: 'publish', payload: { whatever: 1 } }), 'publish')
})

test('两边都空:空时间线,不抛', () => {
  assert.deepEqual(mergeTimeline([], []), [])
})

test('开工作项不显示两遍 —— C 类日志是看板事实的权威,信封的 topic 条目让位', () => {
  const line = mergeTimeline(
    [{ ts: ts(0), actor: 'user', work: 't1', op: 'create', title: '工作项' }],
    [{ at: ms(0), kind: 'work', payload: { topic: 't1', title: '工作项' } },
     { at: ms(5), kind: 'draft', payload: { charCount: 10 } }])
  assert.equal(line.length, 2, '开工作项被显示了两遍')
  assert.deepEqual(line.map((e) => e.source), ['board', 'session'])
  assert.match(describe(line[1]), /10 字/)
})

test('C 类日志里没有 create 时,信封的 topic 条目保留 —— 不能让它凭空消失', () => {
  const line = mergeTimeline([], [{ at: ms(0), kind: 'work', payload: { topic: 't1', title: '工作项' } }])
  assert.equal(line.length, 1)
  assert.match(describe(line[0]), /开工作项/)
})

test('describe 把留言说成人话,人和 agent 分开', () => {
  assert.match(describe({ source: 'board', op: 'comment', actor: 'user', body: '标题再短一点' }), /你.*标题再短一点/)
  assert.match(describe({ source: 'board', op: 'comment', actor: 'agent', body: '改完了,没验' }), /agent.*改完了/)
})

test('agent 写的留言不显示两遍 —— 看板那条为准,信封那条让位', () => {
  const ops = [
    { ts: '2026-08-24T10:00:00.000Z', actor: 'user', work: 't1', op: 'create', title: '甲' },
    { ts: '2026-08-24T10:05:00.000Z', actor: 'agent', work: 't1', op: 'comment', body: '自述', callId: 'call_9' },
  ]
  const events = [
    { at: Date.parse('2026-08-24T10:05:00.000Z'), kind: 'report', callId: 'call_9', payload: { body: '自述', callId: 'call_9' } },
  ]
  const merged = mergeTimeline(ops, events)
  assert.equal(merged.filter((e) => (e.body ?? e.payload?.body) === '自述').length, 1)
})

test('callId 对不上的信封条目不被吃掉 —— 写失败的自述要看得见', () => {
  const ops = [
    { ts: '2026-08-24T10:00:00.000Z', actor: 'user', work: 't1', op: 'create', title: '甲' },
    { ts: '2026-08-24T10:05:00.000Z', actor: 'agent', work: 't1', op: 'comment', body: '自述', callId: 'call_9' },
  ]
  const events = [
    { at: Date.parse('2026-08-24T10:06:00.000Z'), kind: 'report', callId: 'call_10', payload: { error: '写不进去', callId: 'call_10' } },
  ]
  assert.equal(mergeTimeline(ops, events).filter((e) => e.source === 'session').length, 1)
})
