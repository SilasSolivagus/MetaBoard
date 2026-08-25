#!/usr/bin/env node
// @ts-check
/**
 * MetaBoard 的命令行。
 *
 * 这是 D 方案(界面另起)的第一个形态。刻意先做 CLI 而不是网页看板:承重的东西是
 * 「跨进程的数据路径」——外部程序读 dsh 的日志、写自己的选题表、把两条线并起来。
 * 那条路通不通,用 CLI 就能验完;先堆界面只会把风险推后。
 */
import { readOps, fold, appendChecked, createWork, storePath, STATUSES, MAIN_STATUSES,
  SECONDARY_STATUSES, STATUS_LABEL, opWork } from '../store/works.mjs'
import { collectEvents, eventSummary, sessionRoot } from '../store/sessions.mjs'
import { mergeTimeline, describe } from '../store/timeline.mjs'
import { appendProjectChecked, readProjectOps, foldProjects, createProject, projectsPath } from '../store/projects.mjs'

const now = () => new Date().toISOString()
const hhmm = (/** @type {number} */ ms) => {
  const d = new Date(ms)
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 从参数里摘掉一个带值的旗标,返回它的值。
 *
 * 摘掉是必须的 —— 标题是 rest.join(' ') 拼出来的,旗标留在里面会变成标题的一部分,
 * 然后被写进只追加的日志里删不掉。
 *
 * 两种「敲了但没生效」的写法直接报错,不猜:
 *   metaboard new 标题 --project p1 --project p2   哪个算数?
 *   metaboard new 标题 --project                   值呢?
 * 沉默地取第一个、或沉默地当没写过,都会让人以为自己的输入生效了。
 *
 * @param {string[]} rest @param {string} name
 * @returns {string|undefined}
 */
function takeFlag(rest, name) {
  const i = rest.indexOf(name)
  if (i === -1) return undefined
  if (rest.indexOf(name, i + 1) !== -1) throw new Error(`${name} 给了不止一个`)
  if (i + 1 >= rest.length) throw new Error(`${name} 后面要跟一个值`)
  const [, value] = rest.splice(i, 2)
  return value
}

function usage() {
  console.log(`用法：
  metaboard new <标题> [--project <pid>]   记一个想法，落在「待立项」
  metaboard approve <id>            立项：允许 agent 开始做这件事
  metaboard ls [--project <pid>] [--all]   看板：只显示已立项的流水线（--all 连待立项/完成一起列）
  metaboard show <id>               这个工作项的完整时间线（状态变更 + 会话事件）
  metaboard status <id> <状态>       状态取值：${STATUSES.join(' / ')}
  metaboard comment <id> <正文>     给工作项留一句话（要求、疑问、说明）
  metaboard return <id> <理由>      打回：等你确认 → 处理中，理由写进留言
  metaboard rename <id> <新标题>
  metaboard archive <id>
  metaboard set-project <id> <pid|->   归属到项目，- 取消归属
  metaboard project new <名字> [--path <绝对目录>]
  metaboard project ls
  metaboard project rename <pid> <新名字>
  metaboard project archive <pid>
  metaboard doctor                  检查两边的数据源读不读得到

工作项表：${storePath()}
dsh 会话：${sessionRoot()}`)
}

/** @param {string[]} argv */
async function main(argv) {
  const [cmd, ...rest] = argv
  const works = fold(readOps())

  if (cmd === undefined || cmd === 'help' || cmd === '--help') return usage()

  if (cmd === 'project') {
    const [sub, ...args] = rest
    const projects = foldProjects(readProjectOps())
    if (sub === 'new') {
      const path = takeFlag(args, '--path')
      if (path !== undefined && !path.startsWith('/')) return fail('--path 要绝对路径')
      const name = args.join(' ').trim()
      if (name === '') return fail('要给项目一个名字：metaboard project new <名字>')
      // 发号与写下 create 在 createProject 的锁里一起完成 —— 分开两步时两个进程
      // 会都挑到同一个号,后一个的 create 被折叠丢掉,而它已经把这个号报给人了。
      const id = createProject({ actor: 'user', name, path })
      console.log(`${id}  ${name}${path === undefined ? '' : `  ${path}`}`)
      return
    }
    if (sub === 'ls') {
      const alive = [...projects.values()].filter((p) => p.archivedAt === undefined)
      if (alive.length === 0) { console.log('还没有项目。用 metaboard project new <名字> 建一个。'); return }
      for (const p of alive) console.log(`  ${p.id.padEnd(4)} ${p.name}${p.path === undefined ? '' : `  ${p.path}`}`)
      return
    }
    if (sub === 'rename') {
      const [pid, ...words] = args
      if (pid === undefined || !projects.has(pid)) return fail(`没有这个项目：${pid ?? '(未指定)'}`)
      const to = words.join(' ').trim()
      if (to === '') return fail('要给新名字：metaboard project rename <pid> <新名字>')
      appendProjectChecked({ ts: now(), actor: 'user', project: pid, op: 'rename', to })
      console.log(`${pid}  ${to}`)
      return
    }
    if (sub === 'archive') {
      const pid = args[0]
      if (pid === undefined || !projects.has(pid)) return fail(`没有这个项目：${pid ?? '(未指定)'}`)
      appendProjectChecked({ ts: now(), actor: 'user', project: pid, op: 'archive' })
      console.log(`${pid} 已归档。归属它的工作项不动，只是不再参与目录匹配。`)
      return
    }
    return fail(`不认识的 project 子命令：${sub ?? '(未指定)'}`)
  }

  if (cmd === 'set-project') {
    const [id, pid] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    if (pid === undefined) return fail('要指定项目：metaboard set-project <id> <pid|->')
    if (pid === '-') {
      appendChecked({ ts: now(), actor: 'user', work: id, op: 'project', to: null })
      console.log(`${id} 已取消项目归属。`)
      return
    }
    // 项目那本日志只追加、没有删除,所以「刚查到的项目」不会在写下去之前消失 ——
    // 这一条跨两本日志的检查不需要放进同一把锁里。
    if (!foldProjects(readProjectOps()).has(pid)) return fail(`没有这个项目：${pid}`)
    appendChecked({ ts: now(), actor: 'user', work: id, op: 'project', to: pid })
    console.log(`${id} 归到 ${pid}。`)
    return
  }

  if (cmd === 'new') {
    const pid = takeFlag(rest, '--project')
    if (pid !== undefined && !foldProjects(readProjectOps()).has(pid)) return fail(`没有这个项目：${pid}`)
    const title = rest.join(' ').trim()
    if (title === '') return fail('要给工作项一个标题：metaboard new <标题>')
    // 你在这里记下的是想法,不是任务 —— 落在待立项,agent 碰不到,
    // 直到你 approve。agent 在对话里建的项走另一条路,直接是等待认领。
    // 发号与写下 create(以及归属)在 createWork 的锁里一起完成:CLI 与对话里的
    // agent 是两个进程,分开两步就会抢到同一个号。
    const id = createWork({ actor: 'user', title, status: 'backlog', project: pid })
    console.log(`${id}  ${title}\n待立项。想让 agent 做，先 metaboard approve ${id}`)
    return
  }

  if (cmd === 'ls') {
    const pid = takeFlag(rest, '--project')
    const showAll = rest.includes('--all')
    const projects = foldProjects(readProjectOps())
    if (pid !== undefined && !projects.has(pid)) return fail(`没有这个项目：${pid}`)
    const summary = await eventSummary()
    const alive = [...works.values()]
      .filter((t) => showAll || t.archivedAt === undefined)
      .filter((t) => pid === undefined || t.project === pid)
    if (alive.length === 0) {
      console.log(pid === undefined
        ? '还没有工作项。用 metaboard new <标题> 开一个。'
        : `${pid} 下面还没有工作项。用 metaboard new <标题> --project ${pid} 开一个。`)
      return
    }
    // 看板只放已授权的流水线;待立项、完成、取消收在 --all 里。
    // 照 dashi 的 MAIN/SECONDARY 划分 —— 看板不该变成堆场。
    const cols = showAll ? [...MAIN_STATUSES, ...SECONDARY_STATUSES] : MAIN_STATUSES
    // 空态要说话。看板上一个都没有,和「一个工作项都没有」是两回事 ——
    // 前者常见得多:东西都做完了,或者都还没立项。
    if (!alive.some((t) => cols.includes(t.status))) {
      const pend = alive.filter((t) => t.status === 'backlog').length
      console.log(showAll ? '还没有工作项。用 metaboard new <标题> 记一个。'
        : `看板上没有在办的工作项。${pend ? `有 ${pend} 个待立项，metaboard approve <id> 放行。` : '用 metaboard new <标题> 记一个。'}`)
      return
    }
    for (const status of cols) {
      const inCol = alive.filter((t) => t.status === status)
      if (inCol.length === 0) continue
      console.log(`\n${STATUS_LABEL[status]}`)
      for (const t of inCol) {
        const w = summary.get(t.id)
        const tail = w === undefined ? '尚无会话记录' : `${w.count} 条会话记录，最后 ${hhmm(w.lastAt)}`
        const mark = t.archivedAt === undefined ? '' : ' [已归档]'
        // 已经按项目过滤过时不再重复显示项目名 —— 每行都挂同一个名字是噪音。
        const proj = (pid !== undefined || t.project === undefined)
          ? '' : ` [${projects.get(t.project)?.name ?? t.project}]`
        console.log(`  ${t.id.padEnd(5)} ${t.title}${proj}${mark}  —  ${tail}`)
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
    console.log(`${STATUS_LABEL[t.status] ?? t.status}${t.archivedAt === undefined ? '' : '（已归档）'}   由 ${t.actor} 建立`)
    if (t.binding !== undefined) {
      // 认领是拒绝第二个对话的那道闸,可它一直没出现在任何界面上:会话中途死掉之后,
      // 别的对话只会收到一句「被别的对话认领着(<会话 id>)」,而那个 id 人无处可查,
      // 唯一的解法(随便挪一次状态)也没有任何地方写着。所以这里把它印出来,连解法一起。
      console.log(`认领中：会话 ${t.binding.session}（${t.binding.workspace}）`)
      console.log(`别的对话在它上面写会被拒。任意 metaboard status ${t.id} <状态> 都会解除认领。`)
    }
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

  if (cmd === 'approve') {
    const id = rest[0]
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    if (t.status !== 'backlog') return fail(`${id} 已经立过项了（现在是${STATUS_LABEL[t.status]}）`)
    // ifVersion 把「刚才读到它是待立项」和这次写变成一次操作。少了它,中间有别人
    // 挪过状态时,这行 from: 'backlog' 在写下去的一刻就已经是假的了。
    appendChecked({ ts: now(), actor: 'user', work: id, op: 'status', from: 'backlog', to: 'todo' },
      { ifVersion: t.version })
    console.log(`${id} 已立项，agent 可以来接了。`)
    return
  }

  if (cmd === 'status') {
    const [id, to] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    if (!STATUSES.includes(/** @type {any} */ (to))) {
      return fail(`状态只能是：${STATUSES.map((x) => `${x}(${STATUS_LABEL[x]})`).join(' / ')}`)
    }
    // 同 approve:from 写的是刚读到的状态,这是一句关于过去的断言,
    // 所以读与写必须是一次操作。
    appendChecked({ ts: now(), actor: 'user', work: id, op: 'status', from: t.status, to },
      { ifVersion: t.version })
    console.log(`${id}  ${STATUS_LABEL[t.status]} → ${STATUS_LABEL[to]}`)
    return
  }

  if (cmd === 'comment') {
    const [id, ...words] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    const body = words.join(' ').trim()
    if (body === '') return fail('要写点什么：metaboard comment <id> <正文>')
    // 不带 ifVersion:留言不声称工作项处在什么状态,别人同时留了一句话不该让
    // 这句写不进去。要守的只是「工作项存在」,而这条 appendChecked 在锁里重查一遍。
    appendChecked({ ts: now(), actor: 'user', work: id, op: 'comment', body })
    console.log(`${id} 已留言。agent 下次读这个工作项时会看到。`)
    return
  }

  if (cmd === 'return') {
    const [id, ...words] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    if (t.status !== 'in_review') return fail(`${id} 现在是${STATUS_LABEL[t.status]}，不在等你确认，没什么可打回的`)
    const body = words.join(' ').trim()
    if (body === '') return fail('打回要给理由：metaboard return <id> <理由>')
    // 两条一起写。理由落了地而状态没改,读的人会以为活儿还在 agent 手上。
    appendChecked([
      { ts: now(), actor: 'user', work: id, op: 'comment', body },
      { ts: now(), actor: 'user', work: id, op: 'status', from: 'in_review', to: 'in_progress' },
    ], { ifVersion: t.version })
    console.log(`${id} 已打回，理由记在留言里。`)
    return
  }

  if (cmd === 'rename') {
    const [id, ...words] = rest
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    const to = words.join(' ').trim()
    if (to === '') return fail('要给新标题：metaboard rename <id> <新标题>')
    appendChecked({ ts: now(), actor: 'user', work: id, op: 'title', to })
    console.log(`${id}  ${to}`)
    return
  }

  if (cmd === 'archive') {
    const id = rest[0]
    const t = id === undefined ? undefined : works.get(id)
    if (t === undefined) return fail(`没有这个工作项：${id ?? '(未指定)'}`)
    appendChecked({ ts: now(), actor: 'user', work: id, op: 'archive' })
    console.log(`${id} 已归档。事件仍在，show 照常看得到。`)
    return
  }

  if (cmd === 'doctor') {
    const logs = await eventSummary()
    console.log(`工作项表  ${storePath()}`)
    console.log(`        ${works.size} 个工作项`)
    console.log(`项目表    ${projectsPath()}`)
    console.log(`        ${foldProjects(readProjectOps()).size} 个项目`)
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

// takeFlag 抛出的是「敲了但没生效」的错,走 fail() 的老路:stderr + 非零退出,
// 不让它变成没捕获的 rejection、把调用栈甩给用户看。
main(process.argv.slice(2)).catch((/** @type {Error} */ err) => fail(err.message))
