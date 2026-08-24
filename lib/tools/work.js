// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { appendOp, readOps, fold, allocateId, storePath } from '../../store/works.mjs'

const DESCRIPTION =
  'Open a new work item and get back its id. Every other metaboard tool takes that id — '
  + 'you reference a work item, you never name one. Call this only when this genuinely '
  + 'belongs to a new item; to continue existing work, reuse the id you were already given. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function workTool() {
  return defineTool({
    name: 'metaboard_work_create',
    description: DESCRIPTION,
    parameters: {
      title: {
        type: 'string', required: true,
        description: 'What this work item is about, in the words a person would use. Not an id — the id is assigned for you.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', required: true },
          title: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Work item ${value.work} opened: ${value.title}. Pass ${value.work} as \`work\` in every later metaboard call for this item.`
          : `Could not open the work item: ${value.error}`,
      }],
      presentationMeta: (_args, value) => /** @type {any} */ (makeMeta({
        subject: value.work,
        kind: 'work',
        payload: value,
      })),
    },
    async execute(args, exec) {
      try {
        // id 由计数器分配,模型给不了自己想要的号 —— 这是拼写漂移消失的地方。
        const path = storePath()
        const work = allocateId(fold(readOps(path)))
        appendOp({
          ts: new Date().toISOString(),
          actor: 'agent',
          work,
          op: 'create',
          title: args.title,
          // agent 在对话里建项,说明人刚开口要了这件事 —— 那句话就是授权,
          // 所以直接落在「等待认领」,而不是「待立项」。人在 CLI 里记下的想法
          // 才落在待立项,要另外过一次立项。
          status: 'todo',
        }, path)
        return { work, title: args.title, callId: exec.callId }
      } catch (error) {
        // 不重新抛出:抛了会跳过 presentationMeta,信封写不出去,
        // 结果事件不被 Definition 认领,账本上留一行永久 running(R12/R16)。
        return {
          work: '', title: args.title, callId: exec.callId,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}
