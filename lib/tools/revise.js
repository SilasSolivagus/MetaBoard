// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'

const DESCRIPTION =
  'Rewrite a draft against review notes. Set derivedFrom to the callId(s) of the draft and review '
  + 'this revision used — each upstream result names its own call id verbatim for exactly this '
  + 'purpose. This result names its own call id too, for the same reason. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function reviseTool() {
  return defineTool({
    name: 'metaboard_revise',
    description: DESCRIPTION,
    parameters: {
      subject: { type: 'string', required: true, description: 'The topic id used by every call for this topic.' },
      notes: { type: 'string', required: true, description: 'What to change.' },
      derivedFrom: {
        type: 'array',
        description: 'callIds of the draft and review this revision consumed.',
        items: { type: 'string' },
      },
      failForTest: {
        type: 'boolean',
        description: 'Test hook: raise a failure inside the tool body to exercise the failure path.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'integer', required: true },
          removed: { type: 'integer', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Revised: +${value.added} / −${value.removed}. (call id: ${value.callId} — pass this in a later review's derivedFrom)`
          : `Revision failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.subject,
        kind: 'revise',
        derivedFrom: args.derivedFrom,
        payload: value,
      })),
    },
    async execute(args, exec) {
      try {
        if (args.failForTest === true) throw new Error('simulated revision failure')
        return { added: 180, removed: 95, callId: exec.callId }
      } catch (error) {
        // 关键:不重新抛出。抛出会跳过 presentationMeta,meta 不写入,
        // 结果事件不被 Definition 认领,账本留下永久 running 的行。
        return { added: 0, removed: 0, callId: exec.callId, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
