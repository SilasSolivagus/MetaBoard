// @ts-check
/** MetaBoard 的 tool/result.meta 信封:两半共用的唯一判据。 */

/** @type {readonly string[]} */
export const KINDS = ['research', 'draft', 'revise', 'review', 'publish']

/**
 * @param {{ subject: string, kind: string, derivedFrom?: string[], payload: unknown }} input
 * @returns {{ subject: string, kind: string, derivedFrom?: string[], payload: unknown }}
 */
export function makeMeta(input) {
  return {
    subject: input.subject,
    kind: input.kind,
    ...(input.derivedFrom === undefined ? {} : { derivedFrom: input.derivedFrom }),
    payload: input.payload,
  }
}

/**
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
