// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeMeta } from '../envelope.js'

const DESCRIPTION =
  'Record a human review decision on the current draft. In production the board UI writes this '
  + 'directly; this tool exists so the decision can be recorded from a conversation. '
  + 'The result names its own call id — copy that id verbatim into a later metaboard_revise '
  + 'call\'s derivedFrom to record that the revision addressed this review. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function reviewTool() {
  return defineTool({
    name: 'metaboard_review',
    description: DESCRIPTION,
    parameters: {
      subject: { type: 'string', required: true, description: 'The topic id used by every call for this topic.' },
      decision: {
        type: 'string', required: true, enum: ['accept', 'reject'],
        description: 'accept or reject.',
      },
      note: { type: 'string', required: true, description: 'What the reviewer said.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Review recorded. (call id: ${value.callId} — pass this in a later revise's derivedFrom)`
          : `Review failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.subject,
        kind: 'review',
        payload: { decision: args.decision, note: args.note, ...value },
      })),
    },
    async execute(args, exec) {
      try {
        // 写入 user/message 是这个工具存在的意义:人的决定要进模型上下文,
        // 而不是停在 tool/result.meta 里。deferContext 让这条消息在本次
        // tool/result 之后落盘,顺序与 Task 6 的一行呈现假设一致。
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: `[人工评审 · ${args.decision}] ${args.note}` }],
          source: {
            kind: 'plugin',
            plugin: 'metaboard',
            form: 'notice',
            summary: `人工评审 · ${args.decision === 'reject' ? '打回' : '通过'}`,
          },
        }))
        return { recorded: true, callId: exec.callId }
      } catch (error) {
        return { recorded: false, callId: exec.callId, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
