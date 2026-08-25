// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { workState, claim } from '../../store/works.mjs'

const DESCRIPTION =
  'Record a revision you have written. This tool does not rewrite for you — produce the revised '
  + 'text yourself, then pass it as `revised` along with the `notes` you worked from. '
  + 'Set derivedFrom to the callId(s) of the draft and review '
  + 'this revision used — each upstream result names its own call id verbatim for exactly this '
  + 'purpose. This result names its own call id too, for the same reason. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function reviseTool() {
  return defineTool({
    name: 'metaboard_revise',
    description: DESCRIPTION,
    parameters: {
      work: {
        type: 'string', required: true,
        description: 'The work item id from metaboard_work_create (e.g. t7). Reference an existing item — do not invent an id.',
      },
      notes: { type: 'string', required: true, description: 'The review notes you worked from — what you were asked to change.' },
      revised: { type: 'string', required: true, description: 'The full revised text. The article itself, not a description of the changes.' },
      derivedFrom: {
        type: 'array',
        description: 'callIds of the draft and review this revision consumed.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          charCount: { type: 'integer', required: true },
          revised: { type: 'string', required: true },
          notes: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Revision recorded: ${value.charCount} characters. (call id: ${value.callId} — pass this in a later review's derivedFrom)`
          : `Recording failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.work,
        kind: 'revise',
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
          return { charCount: 0, revised: '', notes: args.notes, callId: exec.callId,
            error: 'no conversation identity available — refusing to claim work. This is a runtime problem, not something to work around.' }
        }
        const state = workState(args.work, { session })
        if (!state.ok) {
          return { charCount: 0, revised: '', notes: args.notes, callId: exec.callId, error: state.reason }
        }
        // 认领:第一次在这个工作项上干活,把「等待认领」挪成「处理中」,并记下是谁在做。
        claim(args.work, state.status, { session, workspace: process.cwd() })
        // 记录式:改后正文与依据的意见都原样记下。
        // 桩阶段这里返回的是常量 { added: 180, removed: 95 },且从不读 notes ——
        // 那个 diff 统计是编的。算真的需要上一稿正文,工具手里没有;
        // 留个假数字比没有更糟,所以直接删掉,要统计以后单独做。
        return {
          charCount: args.revised.length,
          revised: args.revised,
          notes: args.notes,
          callId: exec.callId,
        }
      } catch (error) {
        // 关键:不重新抛出。抛出会跳过 presentationMeta,meta 不写入,
        // 结果事件不被 Definition 认领,账本留下永久 running 的行。
        return {
          charCount: 0, revised: '', notes: args.notes, callId: exec.callId,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}
