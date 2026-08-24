// @ts-check
/**
 * 进程间写锁。
 *
 * C 类存储是「只追加日志 + 读时折叠」。只追加保证了两个写者不会互相覆盖,
 * 但保证不了「读出版本 → 比对 → 追加」这三步不被切开 —— 两个进程可以同时
 * 读到版本 5,各追加一条,谁都没察觉。乐观锁要的正是这三步的原子性,
 * 所以这里加一把真锁。
 *
 * 手段是 openSync(path, 'wx'),即 O_CREAT|O_EXCL:文件不存在才创建,存在就抛
 * EEXIST。这个原子性由本地文件系统提供(APFS/ext4 都有)。**NFS 上不成立** ——
 * 老式 NFS 客户端的 O_EXCL 要靠 link() 变通,这里没做。当前的使用场景是同一台
 * 机器上的 dsh 进程与 CLI,不涉及网络文件系统;换场景要先改这里。
 *
 * 这条说明写得这么细,是因为这个项目在原子性上错过一次:MAX_LINE_BYTES 的
 * 注释里曾把 PIPE_BUF 给管道的原子写保证安到普通文件上。不重复。
 *
 * 陈旧锁:持锁进程被 kill 掉不会清理锁文件。超过 staleMs 的锁直接删掉重抢。
 * 代价是极端情况下两个进程可能都认为自己拿到了锁(前一个卡了 10 秒又活过来)。
 * 这个风险换掉的是「一次崩溃让看板永久写不进去」,划算。
 */
import { openSync, closeSync, writeSync, unlinkSync, statSync } from 'node:fs'

/** 超过这个年龄的锁视为持有者已死。 */
export const STALE_MS = 10_000

/** 抢不到锁时最多等多久。 */
export const WAIT_MS = 5_000

/** 同步睡眠。没有 async 的余地 —— appendOp 这条路径全是同步的。 */
function sleep(/** @type {number} */ ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 在 target 上取排他锁，跑 fn，然后放锁。
 * @template T
 * @param {string} target 被保护的文件路径。锁文件是 `${target}.lock`。
 * @param {() => T} fn
 * @param {{ staleMs?: number, waitMs?: number }} [opts]
 * @returns {T}
 */
export function withLock(target, fn, opts = {}) {
  const { staleMs = STALE_MS, waitMs = WAIT_MS } = opts
  const lockPath = `${target}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    /** @type {number} */
    let fd
    try {
      fd = openSync(lockPath, 'wx')
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
      let age
      try {
        age = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        continue // 刚被别人放掉了,重抢。
      }
      if (age > staleMs) {
        try { unlinkSync(lockPath) } catch { /* 别人先删了,一样。 */ }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`lock busy: ${lockPath} (held for ${Math.round(age)}ms)`)
      }
      sleep(25)
      continue
    }
    try {
      // 写进 pid 与时间:锁卡住时人得看得出是谁拿着。
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
    } finally {
      closeSync(fd)
    }
    try {
      return fn()
    } finally {
      try { unlinkSync(lockPath) } catch { /* 已被当成陈旧锁删掉,不必声张。 */ }
    }
  }
}
