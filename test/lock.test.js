// @ts-check
/**
 * 进程间写锁。
 *
 * 为什么需要它:C 类存储是「只追加日志 + 读时折叠」,而乐观锁要求
 * 「读出版本 → 比对 → 追加」三步不可分。只追加本身给不了这个保证 ——
 * 两个进程可以同时读到版本 5,然后各追加一条。
 *
 * 用 openSync(path,'wx'):O_CREAT|O_EXCL 在本地文件系统上是原子的。
 * NFS 上不是 —— 这条写在实现的注释里,别重复 MAX_LINE_BYTES 那次
 * 「把管道的原子性保证安到普通文件上」的错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withLock } from '../store/lock.mjs'

const LOCK_MJS = fileURLToPath(new URL('../store/lock.mjs', import.meta.url))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'metaboard-lock-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('两个进程各加 100 次,结果是 200 —— 没有丢失更新', async () => {
  const s = tempDir()
  try {
    const counter = join(s.dir, 'counter.txt')
    writeFileSync(counter, '0')
    const src = `
      import { readFileSync, writeFileSync } from 'node:fs'
      import { withLock } from ${JSON.stringify(LOCK_MJS)}
      const f = ${JSON.stringify(counter)}
      for (let i = 0; i < 100; i++) {
        withLock(f, () => {
          const n = Number(readFileSync(f, 'utf8'))
          writeFileSync(f, String(n + 1))
        }, { waitMs: 30_000 })
      }
    `
    const run = () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'inherit' })
      p.on('exit', (code) => code === 0 ? resolve(undefined) : reject(new Error(`exit ${code}`)))
    })
    await Promise.all([run(), run()])
    assert.equal(readFileSync(counter, 'utf8'), '200')
  } finally { s.cleanup() }
})

test('陈旧的锁会被打破,不会把后来者永远挡在外面', () => {
  const s = tempDir()
  try {
    const target = join(s.dir, 'x.txt')
    writeFileSync(target, 'ok')
    closeSync(openSync(`${target}.lock`, 'w'))
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${target}.lock`, old, old)
    const got = withLock(target, () => 'ran', { staleMs: 10_000, waitMs: 200 })
    assert.equal(got, 'ran')
  } finally { s.cleanup() }
})

test('锁被占着且没过期时,等到超时就抛,不无限等', () => {
  const s = tempDir()
  try {
    const target = join(s.dir, 'x.txt')
    writeFileSync(target, 'ok')
    closeSync(openSync(`${target}.lock`, 'w'))
    assert.throws(() => withLock(target, () => 'ran', { staleMs: 60_000, waitMs: 150 }), /lock busy/)
  } finally { s.cleanup() }
})

test('fn 抛异常时锁也要放掉', () => {
  const s = tempDir()
  try {
    const target = join(s.dir, 'x.txt')
    writeFileSync(target, 'ok')
    assert.throws(() => withLock(target, () => { throw new Error('boom') }), /boom/)
    assert.equal(withLock(target, () => 'second', { waitMs: 200 }), 'second')
  } finally { s.cleanup() }
})
