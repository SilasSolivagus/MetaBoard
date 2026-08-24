// @ts-check
/**
 * C 类存储:工作项表。
 *
 * 形态是「只追加的操作日志 + 读时折叠」,不是「存当前值的表」。选这个形态的理由
 * 不是简单,是它让状态变更本身成为事件 —— 于是 dsh 的工作事件和 MetaBoard 的
 * 状态变更可以按时间戳合并成一条时间线。参照项目 dashi-taskboard 用的是
 * 「tasks 表存当前值 + task_activities 表存字段审计」,两张表各自为政,
 * 而它的 AI 会话记录又是第三本账 —— 那正是本项目要补的那一层,不能照抄。
 *
 * 身份沿用 dashi 的做法:id 由计数器分配,谁都不能命名。模型只能引用,不能取名,
 * 拼写漂移(topic:nas / topic:NAS / topic:nas-2026 裂成三张卡)在源头消失。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STATUSES, MAIN_STATUSES, SECONDARY_STATUSES, STATUS_LABEL, AGENT_FORBIDDEN,
  MAX_LINE_BYTES, storePath, appendOp, readOps, fold, allocateId, workState,
} from '../store/works.mjs'

/** 每个用例一个干净的 store 目录,不碰真实的 ~/.metaboard/。 */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'metaboard-test-'))
  return { dir, path: join(dir, 'works.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const at = (/** @type {number} */ n) => new Date(Date.UTC(2026, 7, 24, 10, n)).toISOString()

test('storePath 默认在 ~/.metaboard/,可用 METABOARD_HOME 覆盖', () => {
  const saved = process.env.METABOARD_HOME
  try {
    delete process.env.METABOARD_HOME
    assert.match(storePath(), /\.metaboard\/works\.jsonl$/)
    process.env.METABOARD_HOME = '/tmp/xyz'
    assert.equal(storePath(), '/tmp/xyz/works.jsonl')
  } finally {
    if (saved === undefined) delete process.env.METABOARD_HOME
    else process.env.METABOARD_HOME = saved
  }
})

test('create 之后折叠出一个工作项,状态是 initial', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: '夜跑装备怎么选' }, s.path)
    const works = fold(readOps(s.path))
    assert.equal(works.size, 1)
    const t = works.get('t1')
    assert.equal(t.title, '夜跑装备怎么选')
    assert.equal(t.status, 'backlog')
    assert.equal(t.actor, 'user')
    assert.equal(t.createdAt, at(1))
    assert.equal(t.archivedAt, undefined)
  } finally { s.cleanup() }
})

test('折叠取最后一次变更 —— 存的是变更,不是当前值', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: '初名' }, s.path)
    appendOp({ ts: at(2), actor: 'agent', work: 't1', op: 'status', from: 'backlog', to: 'in_progress' }, s.path)
    appendOp({ ts: at(3), actor: 'user', work: 't1', op: 'title', to: '改过的名' }, s.path)
    appendOp({ ts: at(4), actor: 'user', work: 't1', op: 'status', from: 'in_progress', to: 'in_review' }, s.path)
    const t = fold(readOps(s.path)).get('t1')
    assert.equal(t.title, '改过的名')
    assert.equal(t.status, 'in_review')
    assert.equal(t.updatedAt, at(4))
    // 全部历史仍在原始日志里 —— 这是合并时间线的原料。
    assert.equal(readOps(s.path).length, 4)
  } finally { s.cleanup() }
})

test('archive 是软归档:工作项还在,只是带上 archivedAt', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: 'x' }, s.path)
    appendOp({ ts: at(2), actor: 'user', work: 't1', op: 'archive' }, s.path)
    const t = fold(readOps(s.path)).get('t1')
    assert.equal(t.archivedAt, at(2))
    assert.equal(t.title, 'x', '归档不该丢掉任何信息')
  } finally { s.cleanup() }
})

test('id 由计数器分配,单调递增,不复用归档掉的号', () => {
  const s = tempStore()
  try {
    assert.equal(allocateId(fold(readOps(s.path))), 't1')
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: 'a' }, s.path)
    assert.equal(allocateId(fold(readOps(s.path))), 't2')
    appendOp({ ts: at(2), actor: 'agent', work: 't2', op: 'create', title: 'b' }, s.path)
    appendOp({ ts: at(3), actor: 'user', work: 't2', op: 'archive' }, s.path)
    assert.equal(allocateId(fold(readOps(s.path))), 't3', '归档掉的号不能被重新分配')
  } finally { s.cleanup() }
})

test('actor 记下来 —— 垃圾卡靠它筛', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: '真工作项' }, s.path)
    appendOp({ ts: at(2), actor: 'agent', work: 't2', op: 'create', title: 'topic:probe' }, s.path)
    const works = fold(readOps(s.path))
    assert.equal(works.get('t1').actor, 'user')
    assert.equal(works.get('t2').actor, 'agent')
  } finally { s.cleanup() }
})

// ─────────────────────── 约束 ───────────────────────

test('状态必须是枚举里的值,不是自由字符串', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: 'x' }, s.path)
    assert.throws(
      () => appendOp({ ts: at(2), actor: 'user', work: 't1', op: 'status', from: 'backlog', to: '随便写' }, s.path),
      /status/,
    )
    assert.deepEqual(STATUSES,
      ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])
  } finally { s.cleanup() }
})

test('未知 op 直接抛,不写进日志', () => {
  const s = tempStore()
  try {
    assert.throws(() => appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'nonesuch' }, s.path), /op/)
    assert.deepEqual(readOps(s.path), [], '抛错的操作不能留下半行')
  } finally { s.cleanup() }
})

// 这条钉的是纪律,不是原子性。理由见 store/works.mjs 里 MAX_LINE_BYTES 的注释:
// 4096 来自 PIPE_BUF,那是管道的保证,不是普通文件的。留这条上限是为了强制
// 「内容不进 C 类日志」,顺带让日志能被人直接读。
test('单行超过 4096 字节必须抛错,不能写进去', () => {
  const s = tempStore()
  try {
    const huge = { ts: at(1), actor: 'user', work: 't1', op: 'create', title: 'x'.repeat(MAX_LINE_BYTES) }
    assert.throws(() => appendOp(huge, s.path), /4096|字节|bytes/)
    assert.deepEqual(readOps(s.path), [])
  } finally { s.cleanup() }
})

test('内容不该进 C 类日志 —— 正文放 dsh 的信封里', () => {
  // 这条不是机制约束,是把设计意图钉住:操作只放 id 与短字段。
  // 一旦有人想往里塞正文,4096 那条会先拦住他。
  const s = tempStore()
  try {
    const article = { ts: at(1), actor: 'user', work: 't1', op: 'create', title: '标题', draft: '正文'.repeat(2000) }
    assert.throws(() => appendOp(article, s.path), /4096|字节|bytes/)
  } finally { s.cleanup() }
})

test('读一个还不存在的日志:空数组,不抛', () => {
  const s = tempStore()
  try {
    assert.deepEqual(readOps(s.path), [])
    assert.equal(fold(readOps(s.path)).size, 0)
  } finally { s.cleanup() }
})

test('损坏的行被跳过,不让整个看板崩掉', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: 'a' }, s.path)
    writeFileSync(s.path, readFileSync(s.path, 'utf8') + '{这不是 JSON\n')
    appendOp({ ts: at(2), actor: 'user', work: 't2', op: 'create', title: 'b' }, s.path)
    const works = fold(readOps(s.path))
    assert.equal(works.size, 2, '一行坏了不该带走其余的行')
  } finally { s.cleanup() }
})

// ─────────────────────── 并发追加 ───────────────────────

// 这条是回归,不是证明,边界要说清楚。
// 起两个真进程各追加 200 行,验证在我们实际使用的行长下,日志仍然是良构的。
// 它**不能**证明 O_APPEND 的原子性 —— 实测过:把行放大到约 18KB(远超 MAX_LINE_BYTES)
// 同样零损坏。也就是说这台机器上安全与不安全的写法都通过,这条测试在原子性这个
// 维度上没有鉴别力。它能抓到的是别的东西:appendOp 的写入路径被改坏(比如换成
// 先读后写、或改成非追加模式),那时它会红。
test('两个真进程并发追加 400 行,一行不丢、一行不坏', async () => {
  const s = tempStore()
  try {
    const worker = `
      import { appendOp } from '${new URL('../store/works.mjs', import.meta.url).href}'
      const [path, tag] = process.argv.slice(2)
      for (let i = 0; i < 200; i++) {
        appendOp({ ts: new Date(Date.UTC(2026, 7, 24, 10, 0, i)).toISOString(),
                   actor: 'user', work: tag + i, op: 'create',
                   title: tag + ' 的第 ' + i + ' 个工作项，标题拉长一点更容易撞出交错：' + 'x'.repeat(200) }, path)
      }
    `
    const workerPath = join(s.dir, 'worker.mjs')
    writeFileSync(workerPath, worker)
    const { spawn } = await import('node:child_process')
    const run = (/** @type {string} */ tag) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [workerPath, s.path, tag], { stdio: 'inherit' })
      p.on('exit', (code) => code === 0 ? resolve(undefined) : reject(new Error(`worker ${tag} exited ${code}`)))
    })
    await Promise.all([run('A'), run('B')])

    const raw = readFileSync(s.path, 'utf8').split('\n').filter((l) => l.trim() !== '')
    assert.equal(raw.length, 400, '行数不对 —— 有写入丢失或多出半行')
    // 每一行都必须是完整 JSON。交错会让 JSON.parse 失败,这正是要抓的。
    for (const [i, line] of raw.entries()) {
      assert.doesNotThrow(() => JSON.parse(line), `第 ${i + 1} 行不是完整 JSON,发生了交错:\n${line.slice(0, 120)}`)
    }
    const works = fold(readOps(s.path))
    assert.equal(works.size, 400)
  } finally { s.cleanup() }
})

// ─────────────────────── 看板/二级的划分 ───────────────────────

test('看板只放已授权的流水线,待立项与完成收在别处', () => {
  // 照 dashi 的 MAIN_STATUSES / SECONDARY_STATUSES 划分。
  assert.deepEqual([...MAIN_STATUSES], ['todo', 'in_progress', 'blocked', 'in_review'])
  assert.deepEqual([...SECONDARY_STATUSES], ['backlog', 'done', 'canceled'])
  // 两边合起来必须正好是全集,不能有状态无处安放。
  assert.deepEqual([...MAIN_STATUSES, ...SECONDARY_STATUSES].sort(), [...STATUSES].sort())
})

test('每个状态都有中文标签 —— 界面上不该出现裸的英文枚举值', () => {
  for (const s of STATUSES) assert.equal(typeof STATUS_LABEL[s], 'string', `${s} 没有标签`)
})

test('agent 不能宣布完成', () => {
  // dashi 的 AGENTS.md:"Never move an issue to `done` unless the user explicitly
  // accepts it",批次完成检查里还专门要求"changed issues are in in_review, not done"。
  assert.deepEqual([...AGENT_FORBIDDEN], ['done'])
  assert.equal(AGENT_FORBIDDEN.includes('blocked'), false, 'agent 该能说自己卡住了')
  assert.equal(AGENT_FORBIDDEN.includes('canceled'), false, 'agent 该能说这事不做了')
})

test('workState:未立项与取消都拒绝,其余放行并带回当前状态', () => {
  const s = tempStore()
  try {
    const mk = (/** @type {string} */ id, /** @type {string} */ status) =>
      appendOp({ ts: at(1), actor: 'user', work: id, op: 'create', title: id, status }, s.path)
    mk('a', 'backlog'); mk('b', 'todo'); mk('c', 'canceled'); mk('d', 'in_review')
    assert.equal(workState('a', s.path).ok, false)
    assert.equal(workState('c', s.path).ok, false)
    assert.deepEqual(workState('b', s.path), { ok: true, status: 'todo' })
    assert.deepEqual(workState('d', s.path), { ok: true, status: 'in_review' })
    assert.equal(workState('nope', s.path).ok, false)
  } finally { s.cleanup() }
})
