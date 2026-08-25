// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { appendOp, readOps, fold, allocateId, storePath } from '../../store/works.mjs'

const DESCRIPTION =
  'Record a new work item and get back its id. Three rules govern work items:\n'
  + '1. What you record here lands in the backlog. Recording a requirement is not '
  + 'permission to act on it — the person approves it separately.\n'
  + '2. You may only do work on items the person has already approved. If a metaboard '
  + 'tool tells you an item is not approved for execution, stop and say so; do not work '
  + 'around it by creating a fresh item.\n'
  + '3. You reference a work item by the id you were given; you never name one.\n'
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
      project: {
        type: 'string',
        description: 'The project id this work belongs to (e.g. p1), when you know it. Omit when you do not — do not guess.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', required: true },
          title: { type: 'string', required: true },
          project: { type: 'string' },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Recorded as ${value.work}: ${value.title}. It is in the backlog and not approved for execution — do not start work on it. Once the person approves it, pass ${value.work} as \`work\` in later metaboard calls.`
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
        if (args.project !== undefined) {
          // 归到不存在的项目不能悄悄丢掉 —— 那样这条工作项就成了一句谎:它以为
          // 自己有归属,实际没有。先查清楚,查不到就报错,不落地。
          const { readProjectOps, foldProjects } = await import('../../store/projects.mjs')
          if (!foldProjects(readProjectOps()).has(args.project)) {
            return { work: '', title: args.title, callId: exec.callId, error: `unknown project: ${args.project}` }
          }
        }
        const work = allocateId(fold(readOps(path)))
        appendOp({
          ts: new Date().toISOString(),
          actor: 'agent',
          work,
          op: 'create',
          title: args.title,
          // 落在待立项,不是等待认领。这一条改过:我原先让它落 todo,理由是
          // 「人刚在对话里开口要了,那句话就是授权」。参照项目的判断相反 ——
          // 它的 issue create 默认就是 backlog,agent 建项时不传 --status。
          //
          // 它是对的,两个理由:
          //   1. 记录一个需求不等于授权去做它。agent 聊着聊着说「顺带还该写篇 X」,
          //      它应该记下来,但不该自己开始写。
          //   2. 否则这道门形同虚设 —— agent 想干活,新建一个自带通行证的条目就行。
          status: 'backlog',
        }, path)
        if (args.project !== undefined) {
          appendOp({ ts: new Date().toISOString(), actor: 'agent', work, op: 'project', to: args.project }, path)
        }
        return { work, title: args.title, project: args.project, callId: exec.callId }
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
