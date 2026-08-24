// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { workExists } from '../../store/works.mjs'

const DESCRIPTION =
  'Record a draft you have written. This tool does not write for you — write the full article '
  + 'yourself, then pass it as `draft`. Set derivedFrom to the call id(s) printed in the '
  + 'result of each metaboard_research call whose sources you used — each research result '
  + 'names its own call id verbatim for exactly this purpose. This result names its own call '
  + 'id too, for the same reason. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function draftTool() {
  return defineTool({
    name: 'metaboard_draft',
    description: DESCRIPTION,
    parameters: {
      work: {
        type: 'string', required: true,
        description: 'The work item id from metaboard_work_create (e.g. t7). Reference an existing item — do not invent an id.',
      },
      draft: {
        type: 'string', required: true,
        description: 'The full text you wrote. The article itself, not an outline or a summary of it.',
      },
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
          charCount: { type: 'integer', required: true },
          draft: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Draft written: ${value.charCount} characters. (call id: ${value.callId} — pass this in a later revise's derivedFrom)`
          : `Draft failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.work,
        kind: 'draft',
        derivedFrom: args.derivedFrom,
        payload: value,
      })),
    },
    async execute(args, exec) {
      try {
        // 工作项只能引用,不能命名。未知 id 返回带 error 的结果而不是抛异常 ——
        // 抛了会跳过 presentationMeta,账本上留一行永久 running(R12/R16)。
        if (!workExists(args.work)) {
          return { charCount: 0, draft: '', callId: exec.callId, error: `unknown work item: ${args.work}` }
        }
        // 记录式:模型写的正文一个字不动地记下来。charCount 是可核对的事实,不是加工。
        return { charCount: args.draft.length, draft: args.draft, callId: exec.callId }
      } catch (error) {
        return { charCount: 0, draft: '', callId: exec.callId, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
