// @ts-check
/**
 * CLI 的行为。
 *
 * 之前没有 CLI 测试 —— 命令面小、改动少的时候能忍。项目层把它变成了人这一侧
 * 唯一的入口(agent 侧走工具),再靠手跑就会漏。
 *
 * 用子进程跑真的 bin,不 import 内部函数:要验的正是「参数解析 + 输出文案」这一层。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../cli/metaboard.mjs', import.meta.url))

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'metaboard-cli-'))
  return {
    dir,
    /** @param {string[]} args */
    run: (args) => execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, METABOARD_HOME: dir, DSH_SESSIONS_HOME: join(dir, 'no-sessions') },
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('project new 分配 p1,project ls 列出来', () => {
  const s = box()
  try {
    assert.match(s.run(['project', 'new', '123云盘']), /p1/)
    assert.match(s.run(['project', 'ls']), /p1\s+123云盘/)
  } finally { s.cleanup() }
})

test('new --project 建项时就归属,ls --project 只看这个项目', () => {
  const s = box()
  try {
    s.run(['project', 'new', '甲项目'])
    s.run(['project', 'new', '乙项目'])
    s.run(['new', '甲的活儿', '--project', 'p1'])
    s.run(['new', '乙的活儿', '--project', 'p2'])
    s.run(['approve', 't1'])
    s.run(['approve', 't2'])
    const out = s.run(['ls', '--project', 'p1'])
    assert.match(out, /甲的活儿/)
    assert.doesNotMatch(out, /乙的活儿/)
  } finally { s.cleanup() }
})

test('归到不存在的项目要报错,不是默默写进去', () => {
  const s = box()
  try {
    s.run(['new', '活儿'])
    // 不用 /p9/ —— execFileSync 失败时的 message 里总带着失败的完整命令行(含参数),
    // 光靠 p9 出现在那里,不管 CLI 到底是不是为了这个理由拒绝都会匹配上。
    // 改成 CLI 自己吐出来的措辞,才是真的验到了「没有这个项目」这条判断。
    assert.throws(() => s.run(['set-project', 't1', 'p9']), /没有这个项目/)
  } finally { s.cleanup() }
})

test('project new --path 只收绝对路径', () => {
  const s = box()
  try {
    assert.throws(() => s.run(['project', 'new', '甲', '--path', 'relative/dir']), /绝对路径|absolute/)
  } finally { s.cleanup() }
})

test('旗标重复要报错,而且什么都不写进去', () => {
  const s = box()
  try {
    assert.throws(() => s.run(['new', '活儿', '--project', 'p1', '--project', 'p2']), /--project 给了不止一个/)
    // 拒绝发生在 appendOp 之前 —— 确认真没写进去,不只是报了句话。
    assert.doesNotMatch(s.run(['ls', '--all']), /活儿/)
  } finally { s.cleanup() }
})

test('旗标后面没有值要报错', () => {
  const s = box()
  try {
    assert.throws(() => s.run(['new', '活儿', '--project']), /--project 后面要跟一个值/)
  } finally { s.cleanup() }
})

test('comment 留言,show 里看得到', () => {
  const s = box()
  try {
    s.run(['new', '活儿'])
    s.run(['comment', 't1', '标题再短一点'])
    assert.match(s.run(['show', 't1']), /标题再短一点/)
  } finally { s.cleanup() }
})

test('return 打回:一次动作里既留了理由又改了状态', () => {
  const s = box()
  try {
    s.run(['new', '活儿'])
    s.run(['approve', 't1'])
    s.run(['status', 't1', 'in_review'])
    s.run(['return', 't1', '第三段没有出处'])
    const out = s.run(['show', 't1'])
    assert.match(out, /第三段没有出处/)
    assert.match(out, /处理中/)
  } finally { s.cleanup() }
})

test('不在等你确认的工作项打不回', () => {
  const s = box()
  try {
    s.run(['new', '活儿'])
    s.run(['approve', 't1'])
    assert.throws(() => s.run(['return', 't1', '理由']), /等你确认/)
  } finally { s.cleanup() }
})

// 认领在界面上一直看不见:会话中途死掉之后,别的对话被拒的理由里带着一个
// 会话 id,人无处可查;而唯一的解法(随便挪一次状态会顺带解除认领)也没有
// 任何地方写着。show 得把它印出来。
test('show 印出认领在谁手里,以及怎么解除', () => {
  const s = box()
  try {
    s.run(['new', '活儿'])
    s.run(['approve', 't1'])
    // 直接把 agent 认领的那条状态操作写进日志 —— CLI 这一侧没有认领的入口。
    appendFileSync(join(s.dir, 'works.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), actor: 'agent', work: 't1', op: 'status',
      from: 'todo', to: 'in_progress', binding: { session: 'sess-A', workspace: '/tmp/w' },
    }) + '\n')
    const out = s.run(['show', 't1'])
    assert.match(out, /sess-A/, '认领人没印出来')
    assert.match(out, /metaboard status t1/, '解除认领的办法没写在旁边')
    // 解除之后就不该再印了。
    s.run(['status', 't1', 'in_progress'])
    assert.doesNotMatch(s.run(['show', 't1']), /认领中/)
  } finally { s.cleanup() }
})

// ─────────────────────── 写命令都得走锁 ───────────────────────

// 只有 return 走过 appendChecked,其余的写命令直接 appendOp,不上锁:
// 「读出状态 → 判断 → 追加」这三步中间可以插进 agent 的写入。真实的失败长这样:
// agent 的 handoff 已经折叠完、看到 in_progress,还没写下去;人这时敲了
// metaboard status t1 blocked;handoff 随后写下 from: 'in_progress' —— 一句
// 写下去时就已经不成立的断言,而人的 blocked 被顶掉了。
//
// 探针用陈旧锁:withLock 抢锁时会把超过 STALE_MS 的锁文件删掉再重抢,所以
// 「命令跑完之后这个锁文件不见了」等价于「这条写路径真的进过锁」。
// 不上锁的 appendOp 会绕开它,锁文件原封不动地留在那里。
/** @param {string} target 被保护的日志文件 */
function plantStaleLock(target) {
  const lockPath = `${target}.lock`
  writeFileSync(lockPath, '99999 陈旧的锁\n')
  const longAgo = new Date(Date.now() - 60_000)
  utimesSync(lockPath, longAgo, longAgo)
  return lockPath
}

test('每条写命令都经过锁,不是直接追加', () => {
  const s = box()
  try {
    const works = join(s.dir, 'works.jsonl')
    const projects = join(s.dir, 'projects.jsonl')
    /** @type {[string[], string][]} */
    const cases = [
      [['new', '活儿'], works],
      [['approve', 't1'], works],
      [['status', 't1', 'in_review'], works],
      [['return', 't1', '第三段没有出处'], works],
      [['comment', 't1', '再核一遍出处'], works],
      [['rename', 't1', '改过的标题'], works],
      [['project', 'new', '甲项目'], projects],
      [['set-project', 't1', 'p1'], works],
      [['project', 'rename', 'p1', '乙项目'], projects],
      [['project', 'archive', 'p1'], projects],
      [['archive', 't1'], works],
    ]
    for (const [args, target] of cases) {
      const lockPath = plantStaleLock(target)
      s.run(args)
      assert.equal(existsSync(lockPath), false, `metaboard ${args.join(' ')} 没走锁,直接写了日志`)
    }
    // 命令确实都生效了 —— 否则上面这串断言在「什么都没写」时也会通过。
    const out = s.run(['show', 't1'])
    assert.match(out, /改过的标题/)
    assert.match(out, /第三段没有出处/)
    assert.match(out, /再核一遍出处/)
  } finally { s.cleanup() }
})
