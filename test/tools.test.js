// @ts-check
/**
 * 四个内容工具 + 工作项工具的契约。
 *
 * 两条性质:
 *
 * 1. **记录式** —— 传进去什么就记什么,工具不加工、不编造。桩阶段的毛病正是反过来:
 *    draft 把大纲重复 200 遍冒充正文,revise 返回常量且从不读 notes,
 *    research 返回三条与 query 无关的硬编码素材。这些在账本上都是「安静的假话」。
 *
 * 2. **工作项只能引用,不能命名** —— 参数收的是 store 分配出来的 id。模型自己拼
 *    字符串的年代结束了:实测改造前这台机器历史会话里有 13 个不同的 subject,
 *    9 个是测试垃圾,而且同一个工作项可能被写成三种拼法裂成三张卡。
 *    引用不存在的工作项时**返回带 error 的结果而不是抛异常** —— 抛了会跳过
 *    presentationMeta,信封写不出去,账本上留一行永久 running(R12/R16)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendOp, readOps, fold, workState } from '../store/works.mjs'
import { workTool } from '../lib/tools/work.js'
import { researchTool } from '../lib/tools/research.js'
import { draftTool } from '../lib/tools/draft.js'
import { reviseTool } from '../lib/tools/revise.js'
import { reviewTool } from '../lib/tools/review.js'

const exec = /** @type {any} */ ({ callId: 'call_test_1' })

/**
 * 每个用例一个干净的 ~/.metaboard/。工具在 execute 里读这个日志校验工作项存在,
 * 所以测试必须隔离,不能碰真实的工作项表。
 * @param {(mk: (title?: string) => string) => Promise<void>} body
 */
async function withStore(body) {
  const dir = mkdtempSync(join(tmpdir(), 'metaboard-tools-'))
  const saved = process.env.METABOARD_HOME
  process.env.METABOARD_HOME = dir
  let n = 0
  /**
   * 建一个已立项(等待认领)的工作项 —— 工具能在上面干活。
   * 传 'backlog' 就是未立项,用来验准入那道门。
   */
  const mk = (/** @type {string} */ title = '测试工作项', /** @type {string} */ status = 'todo') => {
    const id = `t${++n}`
    appendOp({
      ts: new Date(Date.UTC(2026, 7, 24, 10, n)).toISOString(),
      actor: 'user', work: id, op: 'create', title, status,
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

// ─────────────────────────── work ───────────────────────────

test('work:分配 id 并写进 store,actor 记成 agent', () => withStore(async () => {
  const value = await workTool().execute({ title: '夜跑装备怎么选' }, exec)
  assert.equal(value.work, 't1')
  assert.equal(value.title, '夜跑装备怎么选')
  assert.equal(value.error, undefined)
  const t = fold(readOps()).get('t1')
  assert.equal(t.title, '夜跑装备怎么选')
  assert.equal(t.actor, 'agent', '模型建的工作项要记成 agent —— 垃圾卡靠这个筛')
  assert.equal(t.status, 'backlog',
    '记录一个需求不等于授权去做它 —— 否则 agent 新建一个自带通行证的条目就绕过了门')
}))

test('work:id 是分配的,模型给不了自己想要的号', () => withStore(async (mk) => {
  mk('已有工作项')
  const value = await workTool().execute({ title: '新工作项' }, exec)
  assert.equal(value.work, 't2', '必须接着已有的号往下发')
}))

test('work:render 把 id 原样告诉模型,后续调用要照抄', () => withStore(async () => {
  const tool = workTool()
  const [block] = tool.output.render({ title: 'x' }, { work: 't7', title: 'x', callId: 'c1' })
  assert.match(block.text, /t7/)
}))

// ─────────────────────────── 引用校验 ───────────────────────────

test('引用不存在的工作项:返回带 error 的结果,不抛异常', () => withStore(async () => {
  const value = await draftTool().execute({ work: 't99', draft: '正文' }, exec)
  assert.equal(value.error !== undefined, true, '未知 topic 必须报错')
  assert.match(value.error, /t99/)
  assert.equal(value.callId, 'call_test_1', '失败也要回显 callId')
}))

test('四个内容工具都校验工作项', () => withStore(async () => {
  const calls = [
    () => researchTool().execute({ work: 't99', query: 'q', sources: [] }, exec),
    () => draftTool().execute({ work: 't99', draft: 'x' }, exec),
    () => reviseTool().execute({ work: 't99', notes: 'n', revised: 'x' }, exec),
    () => reviewTool().execute(
      { work: 't99', decision: 'reject', note: 'n' },
      /** @type {any} */ ({ callId: 'c1', deferContext: () => {} })),
  ]
  for (const call of calls) {
    const value = await call()
    assert.equal(value.error !== undefined, true, '有工具没校验工作项')
  }
}))

test('归档掉的工作项仍然可引用 —— 归档是看板可见性,不是删除', () => withStore(async (mk) => {
  const id = mk('归档的工作项')
  appendOp({ ts: new Date(Date.UTC(2026, 7, 24, 11)).toISOString(), actor: 'user', work: id, op: 'archive' })
  const value = await draftTool().execute({ work: id, draft: '正文' }, exec)
  assert.equal(value.error, undefined, '归档不该让已有内容无法继续记录')
}))

// ─────────────────────────── research ───────────────────────────

const SOURCES = [
  { title: '夜跑装备清单', url: 'https://example.com/a', structure: ['清单', '价格锚点'] },
  { title: '我用夜跑治好了失眠', structure: ['数据开场', '案例', '呼吁'] },
]

test('research:检索意图也要记 —— 账本渲染的是 payload,不是 arguments', () => withStore(async (mk) => {
  const value = await researchTool().execute({ work: mk(), query: '夜跑装备', sources: SOURCES }, exec)
  assert.equal(value.query, '夜跑装备')
}))

test('research:素材逐字记录,不加工', () => withStore(async (mk) => {
  const value = await researchTool().execute({ work: mk(), query: '夜跑装备', sources: SOURCES }, exec)
  assert.deepEqual(value.sources, SOURCES, '工具改动了模型给的素材')
  assert.equal(value.count, 2)
  assert.equal(value.callId, 'call_test_1')
  assert.equal(value.error, undefined)
}))

test('research:unverified 数的是没有 url 的条数', () => withStore(async (mk) => {
  const value = await researchTool().execute({ work: mk(), query: '夜跑装备', sources: SOURCES }, exec)
  assert.equal(value.unverified, 1)
}))

test('research:全部有 url 时 unverified 为 0', () => withStore(async (mk) => {
  const all = SOURCES.map((s) => ({ ...s, url: 'https://example.com/x' }))
  const value = await researchTool().execute({ work: mk(), query: '夜跑装备', sources: all }, exec)
  assert.equal(value.unverified, 0)
}))

test('research:空素材不是错误 —— 没搜到就是没搜到,不编', () => withStore(async (mk) => {
  const value = await researchTool().execute({ work: mk(), query: '夜跑装备', sources: [] }, exec)
  assert.equal(value.count, 0)
  assert.equal(value.unverified, 0)
  assert.deepEqual(value.sources, [])
  assert.equal(value.error, undefined)
}))

test('research:render 把无出处的条数告诉模型,不只报总数', () => {
  const tool = researchTool()
  const [block] = tool.output.render({ work: 't1', query: 'q', sources: SOURCES },
    { query: 'q', count: 2, unverified: 1, sources: SOURCES, callId: 'c1' })
  assert.match(block.text, /2 sources/)
  assert.match(block.text, /1 without a source url/, 'render 没有把无出处的条数告诉模型')
})

test('research:缺必填参数在 execute 之前就抛(ToolArgsError 路径)', () => withStore(async (mk) => {
  await assert.rejects(
    () => researchTool().execute(/** @type {any} */ ({ work: mk(), query: 'q' }), exec),
    'sources 是必填的,漏传应当抛错而不是记一条空素材',
  )
}))

// ─────────────────────────── draft / revise ───────────────────────────

const ARTICLE = '《夜跑装备怎么选》\n\n夜跑和白天跑步最大的不同，不是配速，是风险。'
const REVISED = '《夜跑装备怎么选：先把自己交给光》\n\n改过的开头。'

test('draft:正文逐字记录,工具不写作', () => withStore(async (mk) => {
  const value = await draftTool().execute({ work: mk(), draft: ARTICLE }, exec)
  assert.equal(value.draft, ARTICLE, '工具改动了模型写的正文')
  assert.equal(value.charCount, ARTICLE.length)
  assert.equal(value.callId, 'call_test_1')
}))

test('draft:不再有任何放大 —— 记录的长度就是传进来的长度', () => withStore(async (mk) => {
  const value = await draftTool().execute({ work: mk(), draft: '短' }, exec)
  assert.equal(value.draft, '短')
  assert.equal(value.charCount, 1, '桩阶段这里会是 200')
}))

test('revise:改后正文与依据的意见都逐字记录', () => withStore(async (mk) => {
  const notes = '开头太平,加个钩子'
  const value = await reviseTool().execute({ work: mk(), notes, revised: REVISED }, exec)
  assert.equal(value.revised, REVISED)
  assert.equal(value.notes, notes, 'notes 必须记下来 —— 桩阶段它被完全忽略了')
  assert.equal(value.charCount, REVISED.length)
}))

test('revise:不再返回编造的 diff 统计', () => withStore(async (mk) => {
  const value = await reviseTool().execute({ work: mk(), notes: 'n', revised: REVISED }, exec)
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
    { work: mk(), decision: 'reject', note: '开头太平' }, reviewExec)
  assert.equal(value.recorded, true)
  assert.equal(value.callId, 'call_test_1')
  assert.equal(appended.length, 1, '评审必须写一条进对话上下文')
  assert.equal(appended[0].source.callId, 'call_test_1', '消息要带上写它的那次调用')
}))

// ─────────────────────── 立项这道门 ───────────────────────

// dashi 的 SKILL.md:"Treat `backlog` as not approved for execution. Unless the user
// explicitly authorizes that issue, do not claim it, move it to another status, or
// perform task work." 它靠 prompt 约束 agent;我们让工具直接拒绝,规矩变成机制。
test('未立项的工作项:工具拒绝干活,返回带 error 的结果而不是抛异常', () => withStore(async (mk) => {
  const id = mk('一个还没立项的想法', 'backlog')
  const value = await draftTool().execute({ work: id, draft: '正文' }, exec)
  assert.equal(value.error !== undefined, true, '未立项的条目不该能被 agent 动')
  assert.match(value.error, /not approved|待立项/)
  assert.equal(value.callId, 'call_test_1', '被拒也要回显 callId')
}))

test('四个内容工具都守这道门', () => withStore(async (mk) => {
  const id = mk('未立项', 'backlog')
  const calls = [
    () => researchTool().execute({ work: id, query: 'q', sources: [] }, exec),
    () => draftTool().execute({ work: id, draft: 'x' }, exec),
    () => reviseTool().execute({ work: id, notes: 'n', revised: 'x' }, exec),
    () => reviewTool().execute({ work: id, decision: 'reject', note: 'n' },
      /** @type {any} */ ({ callId: 'c1', deferContext: () => {} })),
  ]
  for (const call of calls) {
    const v = await call()
    assert.equal(v.error !== undefined, true, '有工具没守立项这道门')
  }
}))

test('取消掉的工作项也不许再动', () => withStore(async (mk) => {
  const id = mk('取消的', 'canceled')
  const v = await draftTool().execute({ work: id, draft: 'x' }, exec)
  assert.match(v.error, /canceled|取消/)
}))

// ─────────────────────── 认领 ───────────────────────

test('第一次干活会认领:等待认领 → 处理中,记成 agent', () => withStore(async (mk) => {
  const id = mk('已立项', 'todo')
  await draftTool().execute({ work: id, draft: '正文' }, exec)
  const w = fold(readOps()).get(id)
  assert.equal(w.status, 'in_progress', '干了活却还挂在等待认领')
  const claimOp = readOps().find((o) => o.op === 'status' && o.to === 'in_progress')
  assert.equal(claimOp.actor, 'agent', '认领是 agent 干的,要记在它头上')
  assert.equal(claimOp.from, 'todo')
}))

test('已经在处理中的不重复认领 —— 日志里不该堆一串同样的流转', () => withStore(async (mk) => {
  const id = mk('已立项', 'todo')
  await draftTool().execute({ work: id, draft: 'a' }, exec)
  await draftTool().execute({ work: id, draft: 'b' }, exec)
  await reviseTool().execute({ work: id, notes: 'n', revised: 'c' }, exec)
  const claims = readOps().filter((o) => o.op === 'status' && o.to === 'in_progress')
  assert.equal(claims.length, 1, `认领了 ${claims.length} 次`)
}))

test('等你确认的工作项仍可继续干活,但不再改状态', () => withStore(async (mk) => {
  const id = mk('待确认', 'in_review')
  const v = await reviseTool().execute({ work: id, notes: 'n', revised: 'x' }, exec)
  assert.equal(v.error, undefined, '打回重改不该被门挡住')
  assert.equal(fold(readOps()).get(id).status, 'in_review', '认领只从等待认领起步,不该覆盖别的状态')
}))

test('agent 建的项立刻就被自己的门挡住 —— 记录不等于授权', () => withStore(async () => {
  const created = await workTool().execute({ title: '顺带发现的一件事' }, exec)
  assert.equal(created.error, undefined)
  // 同一个 agent，下一秒就想在这上面干活。
  const v = await draftTool().execute({ work: created.work, draft: '正文' }, exec)
  assert.equal(v.error !== undefined, true,
    'agent 新建一个条目就能自己给自己发通行证的话，这道门等于不存在')
  assert.match(v.error, /not approved|待立项/)
}))
