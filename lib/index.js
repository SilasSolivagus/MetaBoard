// @ts-check
/** MetaBoard host half. */

export const name = 'metaboard'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  console.log('[metaboard] host half loaded')
}
