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
import { mkdtempSync, rmSync } from 'node:fs'
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
