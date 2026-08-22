// @ts-check
/** MetaBoard host half. */
import { researchTool } from './tools/research.js'
import { draftTool } from './tools/draft.js'
import { reviseTool } from './tools/revise.js'

export const name = 'metaboard'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(researchTool())
  ctx.tools.register(draftTool())
  ctx.tools.register(reviseTool())
}
