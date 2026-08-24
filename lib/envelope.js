// @ts-check
/** MetaBoard 的 tool/result.meta 信封:两半共用的唯一判据。 */

/** @type {readonly string[]} */
export const KINDS = ['research', 'draft', 'revise', 'review', 'publish']

/**
 * @param {{ subject: string, kind: string, derivedFrom?: string[], payload: unknown }} input
 * @returns {{ subject: string, kind: string, derivedFrom?: string[], payload: unknown }}
 */
export function makeMeta(input) {
  if (!KINDS.includes(input.kind)) {
    throw new Error(`Unknown MetaBoard kind: ${input.kind}`)
  }
  return {
    subject: input.subject,
    kind: input.kind,
    ...(input.derivedFrom === undefined ? {} : { derivedFrom: input.derivedFrom }),
    payload: input.payload,
  }
}

/**
 * 注意:与 matchMetaBoardEvent 同理,真正在装配器里跑的是 lib/client.js 里内联的
 * 同源实现。这份导出的实现在宿主半没有生产调用者 —— 它是测试的对照物,改这里
 * 必须同步改那里,别当作死代码删掉。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMetaBoardMeta(value) {
  if (typeof value !== 'object' || value === null) return false
  const m = /** @type {Record<string, unknown>} */ (value)
  return typeof m['subject'] === 'string'
    && typeof m['kind'] === 'string'
    && KINDS.includes(m['kind'])
    && 'payload' in m
}

/**
 * 从单个事件抽出 MetaBoard 的业务身份。装配器要求 match 不查历史,
 * 所以这里只能看这一条事件自己。
 *
 * 注意:真正在装配器里跑的是 lib/client.js 里内联的同源实现 —— 工厂形态没有
 * 构建步骤,无法 import 兄弟文件。这份导出的实现是测试的对照物,改这里必须同步
 * 改那里(KINDS 与 isMetaBoardMeta 同理),test/definitions.test.js 会比对两份
 * 实现的行为。
 *
 * tool/result 一律按 toolCallId 认领,不看信封:参数校验失败(defineTool 在
 * execute 之前抛 ToolArgsError)、子派发(exec.parent 存在时 presentationMeta
 * 不执行)、崩溃补齐(session 关闭未决调用)三条路径都会产出没有信封的结果,
 * 只按信封认领会让对应的 Context 永远停在 running。装配器对「没有 start 的
 * update」是显式容忍的,别的工具的结果只会留下一个不产出节点的空 Context。
 *
 * @param {any} event
 * @param {'call' | 'review'} [target]
 * @returns {{ id: string, role: 'start' | 'update' } | null}
 */
export function matchMetaBoardEvent(event, target = 'call') {
  if (target === 'review') {
    if (event.type !== 'user/message') return null
    const source = event.data?.source
    if (source?.kind !== 'plugin' || source?.plugin !== 'metaboard') return null
    return { id: String(event.seq), role: 'start' }
  }
  if (event.type === 'tool/call') {
    const name = event.data?.name
    if (typeof name !== 'string' || !name.startsWith('metaboard_')) return null
    return { id: String(event.data.callId), role: 'start' }
  }
  if (event.type === 'tool/result') {
    const block = event.data?.message?.content?.[0]
    if (block?.type !== 'tool-result') return null
    return { id: String(block.toolCallId), role: 'update' }
  }
  return null
}
