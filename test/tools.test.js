// @ts-check
/**
 * 四个工具的记录式契约。
 *
 * 这一层此前没有单测:第一阶段四个工具都是桩,execute 里只有纯字符串运算,
 * 没什么可测的。改成记录式之后它们有了唯一一条必须成立的性质 ——
 * **传进去什么就记什么,工具不加工、不编造**。桩阶段的毛病正是反过来:
 * draft 把大纲重复 200 遍冒充正文,revise 返回常量 {added:180, removed:95}
 * 且从不读 notes,research 返回三条与 query 无关的硬编码素材。
 * 这些在账本上都是「安静的假话」——不崩,只是不真。
 *
 * defineTool 的包装器会在 execute 之前跑参数校验,所以这里的白盒调用
 * 同时也覆盖了必填参数缺失时抛 ToolArgsError 的那条路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { researchTool } from '../lib/tools/research.js'
import { draftTool } from '../lib/tools/draft.js'
import { reviseTool } from '../lib/tools/revise.js'
import { reviewTool } from '../lib/tools/review.js'

const exec = /** @type {any} */ ({ callId: 'call_test_1' })

// ─────────────────────────── research ───────────────────────────

const SOURCES = [
  { title: '夜跑装备清单', url: 'https://example.com/a', structure: ['清单', '价格锚点'] },
  { title: '我用夜跑治好了失眠', structure: ['数据开场', '案例', '呼吁'] },
]

test('research:检索意图也要记 —— 账本渲染的是 payload,不是 arguments', async () => {
  const value = await researchTool().execute(
    { subject: 'topic:x', query: '夜跑装备', sources: SOURCES }, exec)
  assert.equal(value.query, '夜跑装备')
})

test('research:素材逐字记录,不加工', async () => {
  const value = await researchTool().execute({ subject: 'topic:x', query: '夜跑装备', sources: SOURCES }, exec)
  assert.deepEqual(value.sources, SOURCES, '工具改动了模型给的素材')
  assert.equal(value.count, 2)
  assert.equal(value.callId, 'call_test_1')
  assert.equal(value.error, undefined)
})

test('research:unverified 数的是没有 url 的条数', async () => {
  const value = await researchTool().execute({ subject: 'topic:x', query: '夜跑装备', sources: SOURCES }, exec)
  // 两条素材,一条有 url 一条没有。
  assert.equal(value.unverified, 1)
})

test('research:全部有 url 时 unverified 为 0', async () => {
  const all = SOURCES.map((s) => ({ ...s, url: 'https://example.com/x' }))
  const value = await researchTool().execute({ subject: 'topic:x', query: '夜跑装备', sources: all }, exec)
  assert.equal(value.unverified, 0)
})

test('research:空素材不是错误 —— 没搜到就是没搜到,不编', async () => {
  const value = await researchTool().execute({ subject: 'topic:x', query: '夜跑装备', sources: [] }, exec)
  assert.equal(value.count, 0)
  assert.equal(value.unverified, 0)
  assert.deepEqual(value.sources, [])
  assert.equal(value.error, undefined)
})

test('research:render 把未核实的条数告诉模型,不只报总数', () => {
  const tool = researchTool()
  const [block] = tool.output.render({ subject: 'topic:x', query: '夜跑装备', sources: SOURCES },
    { count: 2, unverified: 1, sources: SOURCES, callId: 'c1' })
  assert.match(block.text, /2 sources/)
  assert.match(block.text, /1 unverified/, 'render 没有把未核实条数告诉模型')
})

test('research:缺必填参数在 execute 之前就抛(ToolArgsError 路径)', async () => {
  await assert.rejects(
    () => researchTool().execute(/** @type {any} */ ({ subject: 'topic:x', query: 'q' }), exec),
    'sources 是必填的,漏传应当抛错而不是记一条空素材',
  )
})

// ─────────────────────────── draft ───────────────────────────

const ARTICLE = '《夜跑装备怎么选》\n\n夜跑和白天跑步最大的不同，不是配速，是风险。'

test('draft:正文逐字记录,工具不写作', async () => {
  const value = await draftTool().execute({ subject: 'topic:x', draft: ARTICLE }, exec)
  assert.equal(value.draft, ARTICLE, '工具改动了模型写的正文')
  assert.equal(value.charCount, ARTICLE.length)
  assert.equal(value.callId, 'call_test_1')
})

test('draft:不再有任何放大 —— 记录的长度就是传进来的长度', async () => {
  const value = await draftTool().execute({ subject: 'topic:x', draft: '短' }, exec)
  assert.equal(value.draft, '短')
  assert.equal(value.charCount, 1, '桩阶段这里会是 200')
})

// ─────────────────────────── revise ───────────────────────────

const REVISED = '《夜跑装备怎么选：先把自己交给光》\n\n改过的开头。'

test('revise:改后正文与依据的意见都逐字记录', async () => {
  const notes = '开头太平,加个钩子'
  const value = await reviseTool().execute({ subject: 'topic:x', notes, revised: REVISED }, exec)
  assert.equal(value.revised, REVISED)
  assert.equal(value.notes, notes, 'notes 必须记下来 —— 桩阶段它被完全忽略了')
  assert.equal(value.charCount, REVISED.length)
})

test('revise:不再返回编造的 diff 统计', async () => {
  const value = await reviseTool().execute(
    { subject: 'topic:x', notes: 'n', revised: REVISED }, exec)
  assert.equal(value.added, undefined, 'added 是桩阶段编的常量,应当已删除')
  assert.equal(value.removed, undefined, 'removed 同理')
})

// ─────────────────────────── review ───────────────────────────

test('review:本来就是记录式,这一轮不动它', async () => {
  /** @type {any[]} */
  const appended = []
  const reviewExec = /** @type {any} */ ({
    callId: 'call_test_1',
    deferContext: (/** @type {any} */ m) => appended.push(m),
  })
  const value = await reviewTool().execute(
    { subject: 'topic:x', decision: 'reject', note: '开头太平' }, reviewExec)
  assert.equal(value.recorded, true)
  assert.equal(value.callId, 'call_test_1')
  assert.equal(appended.length, 1, '评审必须写一条进对话上下文')
  assert.equal(appended[0].source.callId, 'call_test_1', '消息要带上写它的那次调用')
})
