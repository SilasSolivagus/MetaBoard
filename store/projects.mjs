// @ts-check
/**
 * 项目层:第二本只追加日志。
 *
 * 形态和工作项表一样(只追加 + 读时折叠),理由也一样 —— 改名、归档这些动作本身
 * 就是事件,存当前值再另开一张审计表就回到了参照项目「三本账各自为政」的形状。
 *
 * id 由计数器分配,p1 起。和工作项 id 同一条理由:没有人给项目起 id,
 * 拼写漂移(project:acme / ACME / acme-2026 裂成三个)在源头消失。
 *
 * path 是可选的。dashi 的 project 必须落在磁盘上 —— 它只服务代码活儿;
 * 内容生产的项目没有目录,工单的项目可能有。这是我们比它通用的地方。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { metaboardHome, ACTORS } from './works.mjs'

export const PROJECT_OPS = /** @type {const} */ (['create', 'rename', 'archive'])

export function projectsPath() {
  return join(metaboardHome(), 'projects.jsonl')
}

/** @param {any} op */
function validate(op) {
  if (typeof op !== 'object' || op === null) throw new Error('op must be an object')
  if (!PROJECT_OPS.includes(op.op)) throw new Error(`unknown project op: ${JSON.stringify(op.op)}`)
  // actor 和工作项表一样要校验。两本日志都是只追加、写进去删不掉,校验强度不该不一样。
  if (!ACTORS.includes(op.actor)) throw new Error(`unknown actor: ${JSON.stringify(op.actor)}`)
  if (typeof op.project !== 'string' || op.project === '') throw new Error('op.project must be a non-empty string')
  if (typeof op.ts !== 'string' || Number.isNaN(Date.parse(op.ts))) throw new Error('op.ts must be an ISO timestamp')
  if (op.op === 'create') {
    if (typeof op.name !== 'string' || op.name.trim() === '') throw new Error('create needs a name')
    if (op.path !== undefined && (typeof op.path !== 'string' || !op.path.startsWith('/'))) {
      throw new Error('project path must be an absolute path')
    }
  }
  if (op.op === 'rename' && (typeof op.to !== 'string' || op.to.trim() === '')) throw new Error('rename needs `to`')
}

/** @param {any} op @param {string} [path] */
export function appendProjectOp(op, path = projectsPath()) {
  validate(op)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(op) + '\n', { encoding: 'utf8' })
  return op
}

/** @param {string} [path] @returns {any[]} */
export function readProjectOps(path = projectsPath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return []
    throw error
  }
  /** @type {any[]} */
  const ops = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { ops.push(JSON.parse(line)) } catch { /* 一行坏了不该让看板打不开。 */ }
  }
  return ops
}

/** @param {any[]} ops @returns {Map<string, any>} */
export function foldProjects(ops) {
  /** @type {Map<string, any>} */
  const projects = new Map()
  for (const op of ops) {
    const id = op.project
    if (typeof id !== 'string') continue
    if (op.op === 'create') {
      if (projects.has(id)) continue
      projects.set(id, { id, name: op.name, path: op.path, createdAt: op.ts, archivedAt: undefined })
      continue
    }
    const p = projects.get(id)
    if (p === undefined) continue
    if (op.op === 'rename') p.name = op.to
    else if (op.op === 'archive') p.archivedAt = op.ts
  }
  return projects
}

/** @param {Map<string, any>} projects */
export function allocateProjectId(projects) {
  let max = 0
  for (const id of projects.keys()) {
    const m = /^p(\d+)$/.exec(id)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `p${max + 1}`
}

/**
 * 当前目录属于哪个项目。规则照抄 dashi:
 * 「Treat its project as a workspace match only when `project.workspacePath` is
 *  the current directory or one of its ancestors.」
 * 方向别搞反 —— 是「项目目录是当前目录或它的祖先」,不是反过来。
 * 嵌套时取最长匹配:/a 与 /a/b 都存在时,在 /a/b/c 里应该匹配到 /a/b。
 *
 * 匹配不上返回 undefined,由调用方去问人。不猜。
 *
 * @param {string} cwd
 * @param {Map<string, any>} projects
 */
export function projectForPath(cwd, projects) {
  /** @type {any} */
  let best
  for (const p of projects.values()) {
    if (typeof p.path !== 'string' || p.archivedAt !== undefined) continue
    const base = p.path.endsWith('/') ? p.path.slice(0, -1) : p.path
    if (cwd !== base && !cwd.startsWith(`${base}/`)) continue
    if (best === undefined || base.length > best.path.length) best = p
  }
  return best
}
