// @ts-check
/**
 * 从真实会话日志里采出事件夹具。
 *
 * 为什么要有这个脚本:本项目出现过三次「测试全绿但现实是错的」,每次的根因都一样 ——
 * 手写的事件对象和系统真正产出的形状不符。最典型的一次是把失败信息挂在 data.error 上,
 * 而系统在那条路径上从不产出这种形状,于是测试成功验证了一个不存在的东西。
 * 夹具从真实日志里采,这类错误就写不出来。
 *
 * 用法:
 *   node scripts/harvest-fixture.mjs <会话目录或 .jsonl.zstd 路径> <输出 .json> [说明]
 *
 * 保留策略(逐字保留,不做美化):
 *   - tool/call、tool/result 全部保留,原样。别的工具(bash 等)的也保留 ——
 *     「别的工具的结果被认领但不产出节点」正是要验的行为之一。
 *   - user/message:metaboard 插件写的那些原样保留;其余只留 source,丢掉 content。
 *     两个 Definition 的 match 对 user/message 只读 source,丢正文不改变行为,
 *     而系统提示词与技能目录的正文有几十万字符,留着夹具就没法读了。
 *   - 其余事件类型丢弃 —— match 对它们一律返回 null,留着只是噪音。
 *
 * 丢弃了什么会写进夹具的 _meta,别把它当作逐字日志。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const KEPT_TYPES = new Set(['tool/call', 'tool/result', 'user/message'])

/** @param {string} target 会话目录或 .jsonl.zstd 文件 */
function readLog(target) {
  const path = statSync(target).isDirectory() ? join(target, 'session.jsonl.zstd') : target
  // zstd 解压交给系统的 zstd;Node 没有内置解码器。
  return { path, text: execFileSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 }).toString('utf-8') }
}

/** @param {string} text @returns {{ events: any[], dropped: Record<string, number>, strippedBodies: number }} */
function harvest(text) {
  const events = []
  /** @type {Record<string, number>} */
  const dropped = {}
  let strippedBodies = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (!KEPT_TYPES.has(event.type)) {
      dropped[event.type] = (dropped[event.type] ?? 0) + 1
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      const mine = source?.kind === 'plugin' && source?.plugin === 'metaboard'
      if (!mine) {
        strippedBodies += 1
        events.push({ seq: event.seq, type: event.type, time: event.time, data: { source } })
        continue
      }
    }
    events.push({ seq: event.seq, type: event.type, time: event.time, data: event.data })
  }
  return { events, dropped, strippedBodies }
}

const [target, out, note] = process.argv.slice(2)
if (!target || !out) {
  console.error('用法: node scripts/harvest-fixture.mjs <会话目录|.jsonl.zstd> <输出.json> [说明]')
  process.exit(2)
}

const { path, text } = readLog(target)
const { events, dropped, strippedBodies } = harvest(text)

const calls = events.filter((e) => e.type === 'tool/call')
const fixture = {
  _meta: {
    note: note ?? '',
    harvestedFrom: path,
    // 采集时间不写进夹具:它会让每次重采都产生 diff,而夹具的价值在于稳定可比。
    totalKept: events.length,
    metaboardCalls: calls.filter((e) => String(e.data?.name ?? '').startsWith('metaboard_')).length,
    foreignCalls: calls.filter((e) => !String(e.data?.name ?? '').startsWith('metaboard_')).length,
    droppedEventTypes: dropped,
    userMessagesStrippedOfBody: strippedBodies,
    warning: '非 metaboard 的 user/message 只留了 source,正文已丢弃。其余事件逐字保留。',
  },
  events,
}

writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
const size = readFileSync(out).length
console.log(`采出 ${events.length} 条事件 → ${out}（${(size / 1024).toFixed(1)} KB）`)
console.log(`  metaboard 调用 ${fixture._meta.metaboardCalls} 次，其他工具 ${fixture._meta.foreignCalls} 次`)
console.log(`  丢弃事件类型:`, dropped)
