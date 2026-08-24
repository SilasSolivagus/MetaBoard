// @ts-check
/** MetaBoard host half. */
import { researchTool } from './tools/research.js'
import { draftTool } from './tools/draft.js'
import { reviseTool } from './tools/revise.js'
import { reviewTool } from './tools/review.js'
import { topicTool } from './tools/topic.js'

export const name = 'metaboard'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(topicTool())
  ctx.tools.register(researchTool())
  ctx.tools.register(draftTool())
  ctx.tools.register(reviseTool())
  ctx.tools.register(reviewTool())
}
