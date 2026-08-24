// @ts-check
/**
 * 读 dsh 会话日志的那条路径。
 *
 * 这条路径是 D 方案的承重接口,而且它读的是 dsh 的实现细节(压缩日志文件的位置与
 * 格式),不是承诺过的契约。所以这里的测试用**真实夹具压成真实 zstd 文件**,
 * 不是喂手写对象 —— 手写事件形状是本项目三次「测试全绿但现实是错的」的共同根因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { listSessionLogs, readSessionEvents, collectEvents, eventSummary } from '../store/sessions.mjs'

const fixture = (/** @type {string} */ name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'))

/**
 * 用真实夹具搭一个和 dsh 同构的会话目录:<root>/<workspace>/<session-id>/session.jsonl.zstd
 * @param {{ id: string, events: any[] }[]} sessions
 */
function tempSessions(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'metaboard-sessions-'))
  for (const s of sessions) {
    const dir = join(root, '--Users-someone--', s.id)
    mkdirSync(dir, { recursive: true })
    const jsonl = s.events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(jsonl, 'utf8')))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('列出会话日志:递归找到,认得出 session id', () => {
  const s = tempSessions([
    { id: 'session-aaa', events: [{ type: 'turn/start', seq: 1 }] },
    { id: 'session-bbb', events: [{ type: 'turn/start', seq: 1 }] },
  ])
  try {
    const logs = listSessionLogs(s.root)
    assert.equal(logs.length, 2)
    assert.deepEqual(logs.map((l) => l.sessionId).sort(), ['session-aaa', 'session-bbb'])
  } finally { s.cleanup() }
})

test('根目录不存在时返回空,不抛 —— 没装过 dsh 也要能跑', () => {
  assert.deepEqual(listSessionLogs('/nonexistent/path/xyz'), [])
})

test('真 zstd 往返:压进去的事件读得回来', async () => {
  const events = fixture('session-full-chain.json').events
  const s = tempSessions([{ id: 'session-real', events }])
  try {
    const [log] = listSessionLogs(s.root)
    const back = await readSessionEvents(log.path)
    assert.equal(back.length, events.length)
    assert.deepEqual(back[0], events[0])
  } finally { s.cleanup() }
})

test('压缩格式不对的文件被跳过,不带走别的会话', async () => {
  const s = tempSessions([{ id: 'session-ok', events: [{ type: 'turn/start', seq: 1 }] }])
  try {
    const bad = join(s.root, '--Users-someone--', 'session-bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'session.jsonl.zstd'), Buffer.from('这不是 zstd'))
    const logs = listSessionLogs(s.root)
    assert.equal(logs.length, 2)
    const all = (await Promise.all(logs.map((l) => readSessionEvents(l.path)))).flat()
    assert.equal(all.length, 1, '坏文件应当被跳过,好文件照读')
  } finally { s.cleanup() }
})

// ─────────────────────── 按工作项收集 ───────────────────────

test('collectEvents:只取该工作项的信封,按时间排序', async () => {
  const events = fixture('session-full-chain.json').events
  const s = tempSessions([{ id: 'session-real', events }])
  try {
    // 这份夹具是第一阶段采的,subject 还是当年的字符串形态。
    const work = await collectEvents('topic:fixture', s.root)
    assert.ok(work.length >= 4, `应当收到完整链路,实际 ${work.length} 条`)
    const kinds = work.map((w) => w.kind)
    assert.deepEqual(kinds, ['research', 'draft', 'review', 'revise'])
    for (let i = 1; i < work.length; i++) {
      assert.ok(work[i].at >= work[i - 1].at, '没有按时间排序')
    }
    assert.equal(work[0].sessionId, 'session-real')
  } finally { s.cleanup() }
})

test('collectEvents:别的工作项的事件不混进来', async () => {
  const s = tempSessions([
    { id: 'a', events: fixture('session-full-chain.json').events },
    { id: 'b', events: fixture('session-business-failure.json').events },
  ])
  try {
    const a = await collectEvents('topic:fixture', s.root)
    const b = await collectEvents('topic:bizfail', s.root)
    assert.ok(a.length > 0 && b.length > 0)
    assert.equal(a.every((w) => w.sessionId === 'a'), true)
    assert.equal(b.every((w) => w.sessionId === 'b'), true)
  } finally { s.cleanup() }
})

test('collectEvents:跨会话的同一个工作项会被合到一起', async () => {
  const chain = fixture('session-full-chain.json').events
  // 同一份事件放进两个会话,模拟一个工作项跨会话推进。
  const s = tempSessions([{ id: 'earlier', events: chain }, { id: 'later', events: chain }])
  try {
    const work = await collectEvents('topic:fixture', s.root)
    const sessions = new Set(work.map((w) => w.sessionId))
    assert.equal(sessions.size, 2, '跨会话聚合没生效 —— 这是任务对象存在的理由')
  } finally { s.cleanup() }
})

test('collectEvents:不认识的工作项返回空,不抛', async () => {
  const s = tempSessions([{ id: 'a', events: fixture('session-full-chain.json').events }])
  try {
    assert.deepEqual(await collectEvents('t999', s.root), [])
  } finally { s.cleanup() }
})

test('collectEvents:derivedFrom 与 payload 原样带出来', async () => {
  const s = tempSessions([{ id: 'a', events: fixture('session-full-chain.json').events }])
  try {
    const work = await collectEvents('topic:fixture', s.root)
    const revise = work.find((w) => w.kind === 'revise')
    assert.ok(revise !== undefined)
    assert.equal(revise.derivedFrom.length, 2, 'revise 引用了 draft 与 review')
    assert.ok(revise.callId !== undefined)
  } finally { s.cleanup() }
})

test('eventSummary:一次扫描出全部工作项的活儿量', async () => {
  const s = tempSessions([
    { id: 'a', events: fixture('session-full-chain.json').events },
    { id: 'b', events: fixture('session-business-failure.json').events },
  ])
  try {
    const by = await eventSummary(s.root)
    assert.ok(by.has('topic:fixture'))
    assert.ok(by.has('topic:bizfail'))
    assert.equal(by.get('topic:fixture').count, 4)
    assert.ok(by.get('topic:fixture').lastAt > 0)
  } finally { s.cleanup() }
})
