// @ts-check
/**
 * 项目层。
 *
 * 为什么要有:工作项现在是平铺的,而认领池要问的是「这个项目有没有没人接的活儿」——
 * 项目是那次查询的主键。dashi 的 project 是一等公民,承着 issue 归属、
 * workspacePath 到目录的映射、以及存架构约定的 project readme。
 *
 * 比 dashi 通用的一点:path 是可选的。dashi 的 project 必须落在磁盘上,
 * 因为它只服务代码活儿;内容生产的项目没有目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendProjectOp, readProjectOps, foldProjects, allocateProjectId, createProject,
  projectForPath, projectsPath } from '../store/projects.mjs'
import { appendOp, readOps, fold } from '../store/works.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'metaboard-proj-'))
  const saved = process.env.METABOARD_HOME
  process.env.METABOARD_HOME = dir
  return {
    dir,
    cleanup: () => {
      if (saved === undefined) delete process.env.METABOARD_HOME
      else process.env.METABOARD_HOME = saved
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const at = (/** @type {number} */ n) => new Date(Date.UTC(2026, 7, 24, 10, n)).toISOString()

test('projectsPath 跟着 METABOARD_HOME 走', () => {
  const s = tempStore()
  try {
    assert.equal(projectsPath(), join(s.dir, 'projects.jsonl'))
  } finally { s.cleanup() }
})

test('id 由计数器分配,p1 起', () => {
  const s = tempStore()
  try {
    assert.equal(allocateProjectId(new Map()), 'p1')
    appendProjectOp({ ts: at(1), actor: 'user', project: 'p1', op: 'create', name: '123云盘' })
    assert.equal(allocateProjectId(foldProjects(readProjectOps())), 'p2')
  } finally { s.cleanup() }
})

test('rename 与 archive 折叠得出来', () => {
  const s = tempStore()
  try {
    appendProjectOp({ ts: at(1), actor: 'user', project: 'p1', op: 'create', name: '旧名' })
    appendProjectOp({ ts: at(2), actor: 'user', project: 'p1', op: 'rename', to: '新名' })
    appendProjectOp({ ts: at(3), actor: 'user', project: 'p1', op: 'archive' })
    const p = foldProjects(readProjectOps()).get('p1')
    assert.equal(p.name, '新名')
    assert.equal(p.archivedAt, at(3))
  } finally { s.cleanup() }
})

// 发号与写下 create 曾经是分开的两步。两个进程同时读到「最大号是 p0」就会都挑 p1:
// 日志里落两条 create,foldProjects 只认第一条,后一个进程却把 p1 当成自己的项目
// 报给了人。这条测试起两个真进程去抢号。
test('两个进程同时建项目:号不重、谁的名字都没被顶掉', async () => {
  const s = tempStore()
  try {
    const file = projectsPath()
    const worker = `
      import { createProject } from '${new URL('../store/projects.mjs', import.meta.url).href}'
      const [file, tag] = process.argv.slice(2)
      for (let i = 0; i < 20; i++) createProject({ actor: 'user', name: tag + i }, file)
    `
    const workerPath = join(s.dir, 'create-worker.mjs')
    writeFileSync(workerPath, worker)
    const { spawn } = await import('node:child_process')
    const run = (/** @type {string} */ tag) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [workerPath, file, tag], { stdio: 'inherit' })
      p.on('exit', (code) => code === 0 ? resolve(undefined) : reject(new Error(`worker ${tag} exited ${code}`)))
    })
    await Promise.all([run('A'), run('B')])

    const creates = readProjectOps().filter((o) => o.op === 'create')
    assert.equal(creates.length, 40)
    assert.equal(new Set(creates.map((o) => o.project)).size, 40, '有两条 create 抢到了同一个号')
    const projects = foldProjects(readProjectOps())
    assert.equal(projects.size, 40)
    assert.equal(new Set([...projects.values()].map((p) => p.name)).size, 40, '有项目的名字被顶掉了')
  } finally { s.cleanup() }
})

test('projectForPath:当前目录等于 path 或是它的子目录才算匹配', () => {
  const s = tempStore()
  try {
    appendProjectOp({ ts: at(1), actor: 'user', project: 'p1', op: 'create', name: '云盘', path: '/Users/x/code/acme' })
    const projects = foldProjects(readProjectOps())
    assert.equal(projectForPath('/Users/x/code/acme', projects)?.id, 'p1')
    assert.equal(projectForPath('/Users/x/code/acme/src/auth', projects)?.id, 'p1')
    assert.equal(projectForPath('/Users/x/code/acme-old', projects), undefined, '前缀相同但不是子目录,不算')
    assert.equal(projectForPath('/Users/x/code', projects), undefined, '祖先目录不算 —— 方向是反的')
  } finally { s.cleanup() }
})

test('嵌套项目取最长匹配', () => {
  const s = tempStore()
  try {
    appendProjectOp({ ts: at(1), actor: 'user', project: 'p1', op: 'create', name: '外', path: '/a' })
    appendProjectOp({ ts: at(2), actor: 'user', project: 'p2', op: 'create', name: '内', path: '/a/b' })
    assert.equal(projectForPath('/a/b/c', foldProjects(readProjectOps()))?.id, 'p2')
  } finally { s.cleanup() }
})

test('归档过的项目不参与路径匹配', () => {
  const s = tempStore()
  try {
    appendProjectOp({ ts: at(1), actor: 'user', project: 'p1', op: 'create', name: '外', path: '/a' })
    appendProjectOp({ ts: at(2), actor: 'user', project: 'p1', op: 'archive' })
    assert.equal(projectForPath('/a', foldProjects(readProjectOps())), undefined)
  } finally { s.cleanup() }
})

test('工作项归到项目,再取消归属', () => {
  const s = tempStore()
  try {
    appendOp({ ts: at(1), actor: 'user', work: 't1', op: 'create', title: '甲' })
    appendOp({ ts: at(2), actor: 'user', work: 't1', op: 'project', to: 'p1' })
    assert.equal(fold(readOps()).get('t1').project, 'p1')
    appendOp({ ts: at(3), actor: 'user', work: 't1', op: 'project', to: null })
    assert.equal(fold(readOps()).get('t1').project, undefined)
  } finally { s.cleanup() }
})

test('actor 必须有效,不合法的 actor 抛出异常且日志未写入', () => {
  const s = tempStore()
  try {
    assert.throws(
      () => appendProjectOp({ ts: at(1), actor: 'garbage', project: 'p1', op: 'create', name: '测试' }),
      /unknown actor/
    )
    assert.equal(readProjectOps().length, 0, '日志应该是空的')
  } finally { s.cleanup() }
})
