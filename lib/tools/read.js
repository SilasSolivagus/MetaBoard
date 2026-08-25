// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { readOps, fold, STATUS_LABEL } from '../../store/works.mjs'
import { readProjectOps, foldProjects } from '../../store/projects.mjs'

const DESCRIPTION =
  'Read a work item: its title, status, project, and the whole comment stream. '
  + 'Comments are the current requirements — including work handed back to you. Read them before '
  + 'deciding what to do, and read again when you resume an item. '
  + 'This tool works on items that are not approved yet: reading is not doing. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function readTool() {
  return defineTool({
    name: 'metaboard_work_read',
    description: DESCRIPTION,
    parameters: {
      work: {
        type: 'string', required: true,
        description: 'The work item id (e.g. t7). Reference an existing item — do not invent an id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          statusLabel: { type: 'string', required: true },
          approved: { type: 'boolean', required: true },
          project: { type: 'string' },
          comments: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                actor: { type: 'string', required: true },
                ts: { type: 'string', required: true },
                body: { type: 'string', required: true },
              },
            },
          },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error !== undefined) return [{ type: 'text', text: `Could not read the work item: ${value.error}` }]
        const head = `${value.work} ${value.title} — ${value.statusLabel}`
          + `${value.project === undefined ? '' : ` · ${value.project}`}`
          + `${value.approved ? '' : ' · NOT approved for execution — do not start work on it'}`
        // 留言正文必须进渲染。摘要成「3 条留言」等于没读到 —— 要求就在正文里。
        const body = value.comments.length === 0
          ? 'No comments yet.'
          : value.comments.map((/** @type {any} */ c) => `[${c.actor} ${c.ts}] ${c.body}`).join('\n')
        return [{ type: 'text', text: `${head}\n${body}` }]
      },
      presentationMeta: (_args, value) => /** @type {any} */ (makeMeta({
        subject: value.work,
        kind: 'read',
        payload: value,
      })),
    },
    async execute(args, exec) {
      // 读不设门(R29):dashi 允许 agent 在 backlog 条目上做只读的事,
      // 我们之前把四个内容工具的门也套在了读上,结果「给还没立项的想法先做点调研」
      // 做不到。门守的是写,不是读。
      try {
        const w = fold(readOps()).get(args.work)
        if (w === undefined) {
          return { work: args.work, title: '', status: '', statusLabel: '', approved: false,
            comments: [], callId: exec.callId, error: `unknown work item: ${args.work}` }
        }
        const project = w.project === undefined
          ? undefined
          : (foldProjects(readProjectOps()).get(w.project)?.name ?? w.project)
        return {
          work: w.id,
          title: w.title,
          status: w.status,
          statusLabel: STATUS_LABEL[w.status] ?? w.status,
          approved: w.status !== 'backlog',
          project,
          comments: w.comments.map((/** @type {any} */ c) => ({ actor: c.actor, ts: c.ts, body: c.body })),
          callId: exec.callId,
        }
      } catch (error) {
        // 不重新抛出:抛了会跳过 presentationMeta,信封写不出去,账本上留一行永久 running(R12/R16)。
        return { work: args.work, title: '', status: '', statusLabel: '', approved: false,
          comments: [], callId: exec.callId,
          error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
