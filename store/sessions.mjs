// @ts-check
/**
 * 读 dsh 的会话日志,按工作项把 MetaBoard 的会话事件抽出来。
 *
 * 这是 D 方案(界面另起)的承重接口:外部进程不经过 dsh 的运行时,直接读它的持久化
 * 日志。要如实说明这条接口的性质 —— 它读的是 `~/.dsh/sessions/**​/session.jsonl.zstd`,
 * 那是 dsh 的**实现细节,不是它对外承诺的契约**。dsh 换了日志格式或压缩方式,这里
 * 就会断。第一阶段判据 2 专门验过 dsh 内部对格式版本的处理(SessionFormatUnsupportedError),
 * 外部读者没有那层保护,得自己扛。
 *
 * 换句话说:这个模块能工作是实测出来的,不是被承诺的。而且第一次跑就应验了 ——
 * 见 readSessionEvents 上的注释:dsh 把日志写成**逐帧拼接的 zstd**,而 Node 的
 * zstdDecompressSync 只解第一帧,一声不响地返回 184 字节(1 条事件),
 * 真实内容是 384 条。不是报错,是安静地少给你 383 条 —— 又一次「安静的假话」。
 *
 * 判断「哪条事件是 MetaBoard 的」不在这里重新写一遍 —— 用 lib/envelope.js 导出的
 * isMetaBoardMeta。这个项目被「两份实现各自演化」咬过三次,不再多开一份判据。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import { isMetaBoardMeta } from '../lib/envelope.js'

/** @returns {string} dsh 会话根目录。DSH_SESSIONS_HOME 覆盖(测试用)。 */
export function sessionRoot() {
  return process.env.DSH_SESSIONS_HOME ?? join(homedir(), '.dsh', 'sessions')
}

/**
 * 列出全部会话日志文件。目录结构是 <root>/<workspace>/<session-id>/session.jsonl.zstd。
 * @param {string} [root]
 * @returns {{ sessionId: string, path: string }[]}
 */
export function listSessionLogs(root = sessionRoot()) {
  /** @type {{ sessionId: string, path: string }[]} */
  const out = []
  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在或读不了:当作没有会话,不让 CLI 崩掉。
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.jsonl.zstd') out.push({ sessionId: dir.split('/').pop() ?? dir, path: p })
    }
  }
  walk(root)
  return out
}

/**
 * 解压并解析一个会话日志。
 *
 * ── 为什么要逐帧解 ──
 * dsh 每次追加写都产出一个独立的 zstd 帧,一个会话日志是几百个帧拼起来的
 * (实测一个 116KB 的日志里有 281 帧)。Node 的 zstdDecompressSync 和流式解压器
 * **都只解第一帧**:前者静默返回第一帧的内容,后者解完第一帧后抛
 * "Unknown frame descriptor"。对照系统 `zstd -dc` 才发现少了 383 条事件。
 *
 * 所以这里逐帧推进:每帧建一个解压流,用 bytesWritten 拿到这一帧消耗了多少输入,
 * 据此移动偏移。后续帧解完必然抛错(流看到下一帧的头),那个错要吞掉 ——
 * 该帧的输出在抛错前已经收到了。
 *
 * 这条路必须异步:bytesWritten 要等流结束才准。
 *
 * 损坏的行跳过 —— 一行坏了不该让整个看板打不开。
 * @param {string} path
 * @returns {Promise<any[]>}
 */
export async function readSessionEvents(path) {
  let buf
  try {
    buf = readFileSync(path)
  } catch {
    return []
  }
  /** @type {Buffer[]} */
  const parts = []
  let offset = 0
  // 上限只是防御失控循环:真实日志的帧数是几百量级。
  for (let frame = 0; offset < buf.length && frame < 100000; frame++) {
    const d = createZstdDecompress()
    /** @type {Buffer[]} */
    const chunks = []
    const finished = new Promise((resolve, reject) => {
      d.on('data', (c) => chunks.push(c))
      d.on('end', resolve)
      d.on('error', reject)
    })
    d.write(buf.subarray(offset))
    d.end()
    try {
      await finished
    } catch {
      // 预期:流读到下一帧的头会抛。本帧的输出已经在 chunks 里。
    }
    const consumed = d.bytesWritten
    if (!consumed) break // 一个字节都没消耗:剩下的不是合法帧,停。
    parts.push(Buffer.concat(chunks))
    offset += consumed
  }
  const text = Buffer.concat(parts).toString('utf8')
  /** @type {any[]} */
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch { /* 跳过损坏的行 */ }
  }
  return events
}

/**
 * 把某个工作项的会话事件从所有会话里收集出来。
 *
 * 只取 `tool/result` 上的信封。评审那条 `user/message` 不单独取 —— 评审的
 * decision 与 note 本来就在 review 信封的 payload 里,取两遍会让时间线上出现两行。
 *
 * @param {string} work 工作项 id
 * @param {string} [root]
 * @returns {Promise<{ at: number, kind: string, callId: string|undefined, sessionId: string, derivedFrom: string[], payload: any }[]>}
 */
export async function collectEvents(work, root = sessionRoot()) {
  /** @type {any[]} */
  const out = []
  for (const { sessionId, path } of listSessionLogs(root)) {
    for (const event of await readSessionEvents(path)) {
      if (event.type !== 'tool/result') continue
      const meta = event.data?.meta
      if (!isMetaBoardMeta(meta) || meta.subject !== work) continue
      out.push({
        at: typeof event.time === 'number' ? event.time : Date.parse(String(event.time)),
        kind: meta.kind,
        callId: event.data?.message?.content?.[0]?.toolCallId,
        sessionId,
        derivedFrom: meta.derivedFrom ?? [],
        payload: meta.payload,
      })
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

/**
 * 收集全部工作项的会话事件计数,用于看板上显示「这个工作项有多少活儿」。
 * 一次扫描扫出全部,比每个工作项各扫一遍便宜。
 * @param {string} [root]
 * @returns {Promise<Map<string, { count: number, lastAt: number }>>}
 */
export async function eventSummary(root = sessionRoot()) {
  /** @type {Map<string, { count: number, lastAt: number }>} */
  const by = new Map()
  for (const { path } of listSessionLogs(root)) {
    for (const event of await readSessionEvents(path)) {
      if (event.type !== 'tool/result') continue
      const meta = event.data?.meta
      if (!isMetaBoardMeta(meta)) continue
      const at = typeof event.time === 'number' ? event.time : Date.parse(String(event.time))
      const cur = by.get(meta.subject) ?? { count: 0, lastAt: 0 }
      by.set(meta.subject, { count: cur.count + 1, lastAt: Math.max(cur.lastAt, at) })
    }
  }
  return by
}

/** 存在性检查用的辅助:统计能读到多少个会话。CLI 的 doctor 用。 */
export function sessionCount(root = sessionRoot()) {
  return listSessionLogs(root).length
}
