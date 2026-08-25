// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { workState, claim } from '../../store/works.mjs'

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
        // 准入:工作项要存在、要已立项、而且没被别的会话认领着。
        // 返回带 error 的结果而不是抛异常:抛了会跳过 presentationMeta,
        // 账本上留一行永久 running(R12/R16)。
        //
        // 会话身份拿不到就不干活(R27)。dashi 的说法是「never create a legacy binding
        // containing only threadId」—— 半个绑定比没有绑定更坏,它看起来像有保护。
        const session = /** @type {any} */ (exec).agent?.id
        if (typeof session !== 'string' || session === '') {
          return { charCount: 0, draft: '', callId: exec.callId,
            error: 'no conversation identity available — refusing to claim work. This is a runtime problem, not something to work around.' }
        }
        const state = workState(args.work, { session })
        if (!state.ok) {
          return { charCount: 0, draft: '', callId: exec.callId, error: state.reason }
        }
        // 认领:第一次在这个工作项上干活,把「等待认领」挪成「处理中」,并记下是谁在做。
        claim(args.work, state.status, { session, workspace: process.cwd() })
        // 记录式:模型写的正文一个字不动地记下来。charCount 是可核对的事实,不是加工。
        return { charCount: args.draft.length, draft: args.draft, callId: exec.callId }
      } catch (error) {
        return { charCount: 0, draft: '', callId: exec.callId, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
