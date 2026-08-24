// @ts-check
/**
 * 四个内容工具 + 选题工具的契约。
 *
 * 两条性质:
 *
 * 1. **记录式** —— 传进去什么就记什么,工具不加工、不编造。桩阶段的毛病正是反过来:
 *    draft 把大纲重复 200 遍冒充正文,revise 返回常量且从不读 notes,
 *    research 返回三条与 query 无关的硬编码素材。这些在账本上都是「安静的假话」。
 *
 * 2. **topic 只能引用,不能命名** —— 参数收的是 store 分配出来的 id。模型自己拼
 *    字符串的年代结束了:实测改造前这台机器历史会话里有 13 个不同的 subject,
 *    9 个是测试垃圾,而且同一个选题可能被写成三种拼法裂成三张卡。
 *    引用不存在的 topic 时**返回带 error 的结果而不是抛异常** —— 抛了会跳过
 *    presentationMeta,信封写不出去,账本上留一行永久 running(R12/R16)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendOp, readOps, fold } from '../store/topics.mjs'
import { topicTool } from '../lib/tools/topic.js'
import { researchTool } from '../lib/tools/research.js'
import { draftTool } from '../lib/tools/draft.js'
import { reviseTool } from '../lib/tools/revise.js'
import { reviewTool } from '../lib/tools/review.js'

const exec = /** @type {any} */ ({ callId: 'call_test_1' })

/**
 * 每个用例一个干净的 ~/.metaboard/。工具在 execute 里读这个日志校验 topic 存在,
 * 所以测试必须隔离,不能碰真实的选题表。
 * @param {(mk: (title?: string) => string) => Promise<void>} body
 */
async function withStore(body) {
  const dir = mkdtempSync(join(tmpdir(), 'metaboard-tools-'))
  const saved = process.env.METABOARD_HOME
  process.env.METABOARD_HOME = dir
  let n = 0
  const mk = (/** @type {string} */ title = '测试选题') => {
    const id = `t${++n}`
    appendOp({
      ts: new Date(Date.UTC(2026, 7, 24, 10, n)).toISOString(),
      actor: 'user', topic: id, op: 'create', title,
    })
    return id
  }
  try {
    await body(mk)
  } finally {
    if (saved === undefined) delete process.env.METABOARD_HOME
    else process.env.METABOARD_HOME = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─────────────────────────── topic ───────────────────────────

test('topic:分配 id 并写进 store,actor 记成 agent', () => withStore(async () => {
  const value = await topicTool().execute({ title: '夜跑装备怎么选' }, exec)
  assert.equal(value.topic, 't1')
  assert.equal(value.title, '夜跑装备怎么选')
  assert.equal(value.error, undefined)
  const t = fold(readOps()).get('t1')
  assert.equal(t.title, '夜跑装备怎么选')
  assert.equal(t.actor, 'agent', '模型建的选题要记成 agent —— 垃圾卡靠这个筛')
  assert.equal(t.status, 'initial')
}))

test('topic:id 是分配的,模型给不了自己想要的号', () => withStore(async (mk) => {
  mk('已有选题')
  const value = await topicTool().execute({ title: '新选题' }, exec)
  assert.equal(value.topic, 't2', '必须接着已有的号往下发')
}))

test('topic:render 把 id 原样告诉模型,后续调用要照抄', () => withStore(async () => {
  const tool = topicTool()
  const [block] = tool.output.render({ title: 'x' }, { topic: 't7', title: 'x', callId: 'c1' })
  assert.match(block.text, /t7/)
}))

// ─────────────────────────── 引用校验 ───────────────────────────

test('引用不存在的 topic:返回带 error 的结果,不抛异常', () => withStore(async () => {
  const value = await draftTool().execute({ topic: 't99', draft: '正文' }, exec)
  assert.equal(value.error !== undefined, true, '未知 topic 必须报错')
  assert.match(value.error, /t99/)
  assert.equal(value.callId, 'call_test_1', '失败也要回显 callId')
}))

test('四个内容工具都校验 topic', () => withStore(async () => {
  const calls = [
    () => researchTool().execute({ topic: 't99', query: 'q', sources: [] }, exec),
    () => draftTool().execute({ topic: 't99', draft: 'x' }, exec),
    () => reviseTool().execute({ topic: 't99', notes: 'n', revised: 'x' }, exec),
    () => reviewTool().execute(
      { topic: 't99', decision: 'reject', note: 'n' },
      /** @type {any} */ ({ callId: 'c1', deferContext: () => {} })),
  ]
  for (const call of calls) {
    const value = await call()
    assert.equal(value.error !== undefined, true, '有工具没校验 topic')
  }
}))

test('归档掉的选题仍然可引用 —— 归档是看板可见性,不是删除', () => withStore(async (mk) => {
  const id = mk('归档的选题')
  appendOp({ ts: new Date(Date.UTC(2026, 7, 24, 11)).toISOString(), actor: 'user', topic: id, op: 'archive' })
  const value = await draftTool().execute({ topic: id, draft: '正文' }, exec)
  assert.equal(value.error, undefined, '归档不该让已有内容无法继续记录')
}))

// ─────────────────────────── research ───────────────────────────

const SOURCES = [
  { title: '夜跑装备清单', url: 'https://example.com/a', structure: ['清单', '价格锚点'] },
  { title: '我用夜跑治好了失眠', structure: ['数据开场', '案例', '呼吁'] },
]

test('research:检索意图也要记 —— 账本渲染的是 payload,不是 arguments', () => withStore(async (mk) => {
  const value = await researchTool().execute({ topic: mk(), query: '夜跑装备', sources: SOURCES }, exec)
  assert.equal(value.query, '夜跑装备')
}))

test('research:素材逐字记录,不加工', () => withStore(async (mk) => {
  const value = await researchTool().execute({ topic: mk(), query: '夜跑装备', sources: SOURCES }, exec)
  assert.deepEqual(value.sources, SOURCES, '工具改动了模型给的素材')
  assert.equal(value.count, 2)
  assert.equal(value.callId, 'call_test_1')
  assert.equal(value.error, undefined)
}))

test('research:unverified 数的是没有 url 的条数', () => withStore(async (mk) => {
  const value = await researchTool().execute({ topic: mk(), query: '夜跑装备', sources: SOURCES }, exec)
  assert.equal(value.unverified, 1)
}))

test('research:全部有 url 时 unverified 为 0', () => withStore(async (mk) => {
  const all = SOURCES.map((s) => ({ ...s, url: 'https://example.com/x' }))
  const value = await researchTool().execute({ topic: mk(), query: '夜跑装备', sources: all }, exec)
  assert.equal(value.unverified, 0)
}))

test('research:空素材不是错误 —— 没搜到就是没搜到,不编', () => withStore(async (mk) => {
  const value = await researchTool().execute({ topic: mk(), query: '夜跑装备', sources: [] }, exec)
  assert.equal(value.count, 0)
  assert.equal(value.unverified, 0)
  assert.deepEqual(value.sources, [])
  assert.equal(value.error, undefined)
}))

test('research:render 把未核实的条数告诉模型,不只报总数', () => {
  const tool = researchTool()
  const [block] = tool.output.render({ topic: 't1', query: 'q', sources: SOURCES },
    { query: 'q', count: 2, unverified: 1, sources: SOURCES, callId: 'c1' })
  assert.match(block.text, /2 sources/)
  assert.match(block.text, /1 unverified/, 'render 没有把未核实条数告诉模型')
})

test('research:缺必填参数在 execute 之前就抛(ToolArgsError 路径)', () => withStore(async (mk) => {
  await assert.rejects(
    () => researchTool().execute(/** @type {any} */ ({ topic: mk(), query: 'q' }), exec),
    'sources 是必填的,漏传应当抛错而不是记一条空素材',
  )
}))

// ─────────────────────────── draft / revise ───────────────────────────

const ARTICLE = '《夜跑装备怎么选》\n\n夜跑和白天跑步最大的不同，不是配速，是风险。'
const REVISED = '《夜跑装备怎么选：先把自己交给光》\n\n改过的开头。'

test('draft:正文逐字记录,工具不写作', () => withStore(async (mk) => {
  const value = await draftTool().execute({ topic: mk(), draft: ARTICLE }, exec)
  assert.equal(value.draft, ARTICLE, '工具改动了模型写的正文')
  assert.equal(value.charCount, ARTICLE.length)
  assert.equal(value.callId, 'call_test_1')
}))

test('draft:不再有任何放大 —— 记录的长度就是传进来的长度', () => withStore(async (mk) => {
  const value = await draftTool().execute({ topic: mk(), draft: '短' }, exec)
  assert.equal(value.draft, '短')
  assert.equal(value.charCount, 1, '桩阶段这里会是 200')
}))

test('revise:改后正文与依据的意见都逐字记录', () => withStore(async (mk) => {
  const notes = '开头太平,加个钩子'
  const value = await reviseTool().execute({ topic: mk(), notes, revised: REVISED }, exec)
  assert.equal(value.revised, REVISED)
  assert.equal(value.notes, notes, 'notes 必须记下来 —— 桩阶段它被完全忽略了')
  assert.equal(value.charCount, REVISED.length)
}))

test('revise:不再返回编造的 diff 统计', () => withStore(async (mk) => {
  const value = await reviseTool().execute({ topic: mk(), notes: 'n', revised: REVISED }, exec)
  assert.equal(value.added, undefined, 'added 是桩阶段编的常量,应当已删除')
  assert.equal(value.removed, undefined, 'removed 同理')
}))

// ─────────────────────────── review ───────────────────────────

test('review:本来就是记录式,写一条进对话上下文并带上 callId', () => withStore(async (mk) => {
  /** @type {any[]} */
  const appended = []
  const reviewExec = /** @type {any} */ ({
    callId: 'call_test_1',
    deferContext: (/** @type {any} */ m) => appended.push(m),
  })
  const value = await reviewTool().execute(
    { topic: mk(), decision: 'reject', note: '开头太平' }, reviewExec)
  assert.equal(value.recorded, true)
  assert.equal(value.callId, 'call_test_1')
  assert.equal(appended.length, 1, '评审必须写一条进对话上下文')
  assert.equal(appended[0].source.callId, 'call_test_1', '消息要带上写它的那次调用')
}))
