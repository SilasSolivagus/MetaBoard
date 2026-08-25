// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { workState, claim, appendChecked } from '../../store/works.mjs'

const DESCRIPTION =
  'Write your own account of what you did on a work item, into the same comment stream the person '
  + 'writes requirements into. Say what changed, how you verified it, what the outcome was, and what '
  + 'risk is left. This is a summary, not the work itself — the work itself goes through the other '
  + 'metaboard tools, which record it as trajectory. '
  + 'Set handoff to true when you are done and the person should look: that moves the item to '
  + '"等你确认" (in_review). You cannot mark anything done — only the person can. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function reportTool() {
  return defineTool({
    name: 'metaboard_report',
    description: DESCRIPTION,
    parameters: {
      work: {
        type: 'string', required: true,
        description: 'The work item id (e.g. t7). Reference an existing item — do not invent an id.',
      },
      body: {
        type: 'string', required: true,
        description: 'What changed, how you verified it, the outcome, and the remaining risk. A summary — the limit is 3000 bytes.',
      },
      handoff: {
        type: 'boolean',
        description: 'True when the work is ready for the person to look at. Moves the item to in_review.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', required: true },
          body: { type: 'string', required: true },
          handedOff: { type: 'boolean', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? (value.handedOff
            ? `Recorded on ${value.work} and handed back — it is now 等你确认. Do not mark it done; only the person can.`
            : `Recorded on ${value.work}.`)
          : `Could not record the report: ${value.error}`,
      }],
      presentationMeta: (_args, value) => /** @type {any} */ (makeMeta({
        subject: value.work,
        kind: 'report',
        payload: value,
      })),
    },
    async execute(args, exec) {
      const fail = (/** @type {string} */ error) =>
        ({ work: args.work, body: args.body, handedOff: false, callId: exec.callId, error })
      try {
        const session = /** @type {any} */ (exec).agent?.id
        if (typeof session !== 'string' || session === '') {
          return fail('no conversation identity available — refusing to claim work. This is a runtime problem, not something to work around.')
        }
        const state = workState(args.work, { session })
        if (!state.ok) return fail(state.reason)
        claim(args.work, { session, workspace: process.cwd() })

        const ts = new Date().toISOString()
        // callId 写进 comment 操作:合并时间线靠它认出「这条自述已经在看板上了」,
        // 让信封那条让位。写前提本身,不写旁证(R21)。
        const ops = [{ ts, actor: 'agent', work: args.work, op: 'comment', body: args.body, callId: exec.callId }]
        // 交回只从 in_progress 走。claim 之后状态一定是 in_progress 或原本就是,
        // 但 blocked/in_review 上再调一次 handoff 不该悄悄改状态。
        const handoff = args.handoff === true
        const from = state.status === 'todo' ? 'in_progress' : state.status
        if (handoff && from !== 'in_progress') {
          return fail(`${args.work} is ${from}, not in_progress — nothing to hand back.`)
        }
        if (handoff) {
          ops.push(/** @type {any} */ ({ ts, actor: 'agent', work: args.work, op: 'status', from, to: 'in_review' }))
        }
        appendChecked(ops, { binding: { session, workspace: process.cwd() } })
        return { work: args.work, body: args.body, handedOff: handoff, callId: exec.callId }
      } catch (error) {
        // 不重新抛出:抛了会跳过 presentationMeta,信封写不出去,账本上留一行永久 running(R12/R16)。
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
