#!/usr/bin/env node
// @ts-check
/**
 * MetaBoard 的命令行。
 *
 * 这是 D 方案(界面另起)的第一个形态。刻意先做 CLI 而不是网页看板:承重的东西是
 * 「跨进程的数据路径」——外部程序读 dsh 的日志、写自己的选题表、把两条线并起来。
 * 那条路通不通,用 CLI 就能验完;先堆界面只会把风险推后。
 */
import { readOps, fold, appendOp, allocateId, storePath, STATUSES, opWork } from '../store/works.mjs'
import { collectEvents, eventSummary, sessionRoot } from '../store/sessions.mjs'
import { mergeTimeline, describe } from '../store/timeline.mjs'

const now = () => new Date().toISOString()
const hhmm = (/** @type {number} */ ms) => {
  const d = new Date(ms)
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function usage() {
  console.log(`用法：
  metaboard new <标题>              开一个工作项，打印分配到的 id
  metaboard ls [--all]              看板：按状态分列（默认不显示已归档）
  metaboard show <id>               这个工作项的完整时间线（状态变更 + 会话事件）
  metaboard status <id> <状态>       状态取值：${STATUSES.join(' / ')}
  metaboard rename <id> <新标题>
  metaboard archive <id>
  metaboard doctor                  检查两边的数据源读不读得到

工作项表：${storePath()}
dsh 会话：${sessionRoot()}`)
}

/** @param {string[]} argv */
async function main(argv) {
  const [cmd, ...rest] = argv
  const works = fold(readOps())

  if (cmd === undefined || cmd === 'help' || cmd === '--help') return usage()

  if (cmd === 'new') {
    const title = rest.join(' ').trim()
    if (title === '') return fail('要给工作项一个标题：metaboard new <标题>')
    const id = allocateId(works)
    appendOp({ ts: now(), actor: 'user', work: id, op: 'create', title })
    console.log(`${id}  ${title}`)
    return
  }

  if (cmd === 'ls') {
    const showAll = rest.includes('--all')
    const summary = await eventSummary()
    const alive = [...works.values()].filter((t) => showAll || t.archivedAt === undefined)
    if (alive.length === 0) {
      console.log('还没有工作项。用 metaboard new <标题> 开一个。')
      return
    }
    for (const status of STATUSES) {
      const inCol = alive.filter((t) => t.status === status)
      if (inCol.length === 0) continue
      console.log(`\n${status}`)
      for (const t of inCol) {
        const w = summary.get(t.id)
        const tail = w === undefined ? '尚无会话记录' : `${w.count} 条会话记录，最后 ${hhmm(w.lastAt)}`
        const mark = t.archivedAt === undefined ? '' : ' [已归档]'
        console.log(`  ${t.id.padEnd(5)} ${t.title}${mark}  —  ${tail}`)
      }
    }
    return
  }

  if (cmd === 'show') {
    const id = rest[0]
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    const ops = readOps().filter((o) => opWork(o) === id)
    const events = await collectEvents(/** @type {string} */ (id))
    console.log(`${t.id}  ${t.title}`)
    console.log(`状态 ${t.status}${t.archivedAt === undefined ? '' : '（已归档）'}   由 ${t.actor} 建立`)
    if (events.length === 0) {
      console.log('\n还没有会话记录。在 dsh 里用 metaboard 工具做事，这里就会出现。')
    }
    console.log('')
    for (const e of mergeTimeline(ops, events)) {
      // 两条线并成一条,来源标出来 —— 读的人得知道哪条是看板动作、哪条是会话里真干的活。
      const tag = e.source === 'board' ? '看板' : '会话'
      console.log(`${hhmm(e.at)}  ${tag}  ${describe(e)}`)
    }
    return
  }

  if (cmd === 'status') {
    const [id, to] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    if (!STATUSES.includes(/** @type {any} */ (to))) {
      return fail(`状态只能是：${STATUSES.join(' / ')}`)
    }
    appendOp({ ts: now(), actor: 'user', work: id, op: 'status', from: t.status, to })
    console.log(`${id}  ${t.status} → ${to}`)
    return
  }

  if (cmd === 'rename') {
    const [id, ...words] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    const to = words.join(' ').trim()
    if (to === '') return fail('要给新标题：metaboard rename <id> <新标题>')
    appendOp({ ts: now(), actor: 'user', work: id, op: 'title', to })
    console.log(`${id}  ${to}`)
    return
  }

  if (cmd === 'archive') {
    const id = rest[0]
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    appendOp({ ts: now(), actor: 'user', work: id, op: 'archive' })
    console.log(`${id} 已归档。事件仍在，show 照常看得到。`)
    return
  }

  if (cmd === 'doctor') {
    const logs = await eventSummary()
    console.log(`工作项表  ${storePath()}`)
    console.log(`        ${works.size} 个工作项`)
    console.log(`dsh 会话 ${sessionRoot()}`)
    console.log(`        ${logs.size} 个 id 在会话里有记录`)
    const orphan = [...logs.keys()].filter((s) => !works.has(s))
    if (orphan.length > 0) {
      // 第一阶段的事件用的是模型即兴写的 subject,不是分配的 id。它们在工作项表里
      // 没有对应记录 —— 如实报出来,不假装看不见。
      console.log(`\n有 ${orphan.length} 个 subject 在会话里出现过但不在工作项表里：`)
      for (const s of orphan) console.log(`  ${s}`)
      console.log('（第一阶段的事件用的是自由填写的 subject，不是分配的 id。）')
    }
    return
  }

  fail(`不认识的命令：${cmd}`)
}

/** @param {string} msg */
function fail(msg) {
  console.error(msg)
  process.exitCode = 1
}

main(process.argv.slice(2))
