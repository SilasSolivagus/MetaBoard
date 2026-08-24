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
    { ts: ts(0), actor: 'user', topic: 't1', op: 'create', title: '选题' },
    { ts: ts(20), actor: 'user', topic: 't1', op: 'status', from: 'drafting', to: 'in_review' },
    { ts: ts(55), actor: 'user', topic: 't1', op: 'status', from: 'revising', to: 'done' },
  ]
  const work = [
    { at: ms(8), kind: 'research', payload: { count: 3, unverified: 0 } },
    { at: ms(14), kind: 'draft', payload: { charCount: 842 } },
    { at: ms(31), kind: 'review', payload: { decision: 'reject', note: '开头太平' } },
    { at: ms(52), kind: 'revise', payload: { charCount: 650 } },
  ]
  const line = mergeTimeline(ops, work)
  assert.deepEqual(line.map((e) => e.source),
    ['board', 'work', 'work', 'board', 'work', 'work', 'board'])
  // 顺序必须严格升序 —— 这是「一条线」的全部意义。
  for (let i = 1; i < line.length; i++) assert.ok(line[i].at >= line[i - 1].at)
})

test('同一毫秒:看板动作排在工作事件前面(呈现选择,已在注释里声明)', () => {
  const line = mergeTimeline(
    [{ ts: ts(5), actor: 'user', topic: 't1', op: 'status', from: 'initial', to: 'drafting' }],
    [{ at: ms(5), kind: 'draft', payload: { charCount: 10 } }])
  assert.deepEqual(line.map((e) => e.source), ['board', 'work'])
})

test('describe:认识的 kind 说具体的', () => {
  assert.match(describe({ source: 'work', kind: 'research', payload: { count: 3, unverified: 1 } }), /3 条素材.*1 条未核实/)
  assert.match(describe({ source: 'work', kind: 'draft', payload: { charCount: 842 } }), /842 字/)
  assert.match(describe({ source: 'work', kind: 'review', payload: { decision: 'reject', note: '开头太平' } }), /打回：开头太平/)
  assert.match(describe({ source: 'work', kind: 'revise', payload: { charCount: 650 } }), /改到 650 字/)
  assert.match(describe({ source: 'board', op: 'status', from: 'initial', to: 'drafting' }), /initial → drafting/)
  assert.match(describe({ source: 'board', op: 'archive' }), /归档/)
})

test('describe:失败要显示成失败,不能被 kind 的正常措辞盖住', () => {
  const text = describe({ source: 'work', kind: 'revise', payload: { charCount: 0, error: 'unknown topic: t999' } })
  assert.match(text, /失败/)
  assert.match(text, /t999/)
  assert.doesNotMatch(text, /改到 0 字/, '失败的调用不该被说成一次正常的改稿')
})

test('describe:不认识的 kind 只报 kind,不瞎说', () => {
  assert.equal(describe({ source: 'work', kind: 'publish', payload: { whatever: 1 } }), 'publish')
})

test('两边都空:空时间线,不抛', () => {
  assert.deepEqual(mergeTimeline([], []), [])
})

test('开选题不显示两遍 —— C 类日志是看板事实的权威,信封的 topic 条目让位', () => {
  const line = mergeTimeline(
    [{ ts: ts(0), actor: 'user', topic: 't1', op: 'create', title: '选题' }],
    [{ at: ms(0), kind: 'topic', payload: { topic: 't1', title: '选题' } },
     { at: ms(5), kind: 'draft', payload: { charCount: 10 } }])
  assert.equal(line.length, 2, '开选题被显示了两遍')
  assert.deepEqual(line.map((e) => e.source), ['board', 'work'])
  assert.match(describe(line[1]), /10 字/)
})

test('C 类日志里没有 create 时,信封的 topic 条目保留 —— 不能让它凭空消失', () => {
  const line = mergeTimeline([], [{ at: ms(0), kind: 'topic', payload: { topic: 't1', title: '选题' } }])
  assert.equal(line.length, 1)
  assert.match(describe(line[0]), /开选题/)
})
