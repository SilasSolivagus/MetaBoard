// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'
import { topicExists } from '../../store/topics.mjs'

const DESCRIPTION =
  'Record same-topic content you have already gathered and broken down. This tool does not '
  + 'search for you — find the pieces first (web_search is the usual way), read them, extract '
  + 'each one\'s structure, then pass them as `sources`. '
  + 'Give a `url` for every piece you actually retrieved. If a piece comes from your own '
  + 'knowledge rather than a retrieved page, leave `url` off — do NOT invent one. Sources '
  + 'without a url are recorded as unverified, which is fine; a fabricated url is not. '
  + 'The result names its own call id — copy that id verbatim into a later metaboard_draft '
  + 'call\'s derivedFrom to record that the draft used this research. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function researchTool() {
  return defineTool({
    name: 'metaboard_research',
    description: DESCRIPTION,
    parameters: {
      topic: {
        type: 'string', required: true,
        description: 'The topic id from metaboard_topic_create (e.g. t7). Reference an existing topic — do not invent an id.',
      },
      query: {
        type: 'string', required: true,
        description: 'What you looked for. Recorded alongside the sources so the ledger shows the search intent, not just the findings.',
      },
      sources: {
        type: 'array',
        required: true,
        description: 'The same-topic pieces you gathered. Pass an empty array if you found nothing — that is a real answer.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'The piece\'s title.' },
            url: { type: 'string', description: 'Where you retrieved it. Omit if it did not come from a retrieved page; never invent one.' },
            structure: {
              type: 'array', required: true, items: { type: 'string' },
              description: 'How the piece is built, section by section, e.g. ["钩子", "冲突", "反转"].',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          unverified: { type: 'integer', required: true },
          callId: { type: 'string', required: true },
          error: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                url: { type: 'string' },
                structure: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Recorded ${value.count} sources, ${value.unverified} unverified (no url). `
            + `(call id: ${value.callId} — pass this in a later draft's derivedFrom)`
          : `Recording failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.topic,
        kind: 'research',
        payload: value,
      })),
    },
    async execute(args, exec) {
      try {
        // topic 只能引用,不能命名。未知 id 返回带 error 的结果而不是抛异常 ——
        // 抛了会跳过 presentationMeta,账本上留一行永久 running(R12/R16)。
        if (!topicExists(args.topic)) {
          return { query: args.query, count: 0, unverified: 0, sources: [], callId: exec.callId, error: `unknown topic: ${args.topic}` }
        }
        // 记录式:模型给什么记什么,一个字不动。工具唯一算的东西是 unverified ——
        // 那是个可核对的事实(有没有 url),不是对素材内容的加工。
        const sources = args.sources
        return {
          query: args.query,
          count: sources.length,
          unverified: sources.filter((s) => s.url === undefined || s.url === '').length,
          sources,
          callId: exec.callId,
        }
      } catch (error) {
        return {
          query: args.query, count: 0, unverified: 0, sources: [], callId: exec.callId,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}
