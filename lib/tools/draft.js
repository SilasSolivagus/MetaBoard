// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'

const DESCRIPTION =
  'Write a draft from gathered sources. Set derivedFrom to the call id(s) printed in the '
  + 'result of each metaboard_research call whose sources you used — each research result '
  + 'names its own call id verbatim for exactly this purpose. This result names its own call '
  + 'id too, for the same reason. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function draftTool() {
  return defineTool({
    name: 'metaboard_draft',
    description: DESCRIPTION,
    parameters: {
      subject: { type: 'string', required: true, description: 'The topic id used by every call for this topic.' },
      outline: { type: 'string', required: true, description: 'The outline to write from.' },
      derivedFrom: {
        type: 'array',
        description: 'callIds of the upstream metaboard calls this draft used.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wordCount: { type: 'integer', required: true },
          draft: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Draft written: ${value.wordCount} words. (call id: ${value.callId} — pass this in a later revise's derivedFrom)`
          : `Draft failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.subject,
        kind: 'draft',
        derivedFrom: args.derivedFrom,
        payload: value,
      })),
    },
    async execute(args, exec) {
      try {
        // 第一阶段直接用大纲扩写成桩文本,以验证大载荷往返。
        const text = args.outline.repeat(200)
        return { wordCount: text.length, draft: text, callId: exec.callId }
      } catch (error) {
        return { wordCount: 0, draft: '', callId: exec.callId, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
