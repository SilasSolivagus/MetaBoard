// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { appendOp, readOps, fold, allocateId, storePath } from '../../store/topics.mjs'

const DESCRIPTION =
  'Open a new topic and get back its id. Every other metaboard tool takes that id — '
  + 'you reference a topic, you never name one. Call this only when the work genuinely '
  + 'belongs to a new topic; to continue existing work, reuse the id you were already given. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function topicTool() {
  return defineTool({
    name: 'metaboard_topic_create',
    description: DESCRIPTION,
    parameters: {
      title: {
        type: 'string', required: true,
        description: 'What this topic is about, in the words a person would use. Not an id — the id is assigned for you.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string', required: true },
          title: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Topic ${value.topic} opened: ${value.title}. Pass ${value.topic} as \`topic\` in every later metaboard call for this work.`
          : `Could not open the topic: ${value.error}`,
      }],
      presentationMeta: (_args, value) => /** @type {any} */ (makeMeta({
        subject: value.topic,
        kind: 'topic',
        payload: value,
      })),
    },
    async execute(args, exec) {
      try {
        // id 由计数器分配,模型给不了自己想要的号 —— 这是拼写漂移消失的地方。
        const path = storePath()
        const topic = allocateId(fold(readOps(path)))
        appendOp({
          ts: new Date().toISOString(),
          actor: 'agent',
          topic,
          op: 'create',
          title: args.title,
        }, path)
        return { topic, title: args.title, callId: exec.callId }
      } catch (error) {
        // 不重新抛出:抛了会跳过 presentationMeta,信封写不出去,
        // 结果事件不被 Definition 认领,账本上留一行永久 running(R12/R16)。
        return {
          topic: '', title: args.title, callId: exec.callId,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}
