// @ts-check
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeMeta } from '../envelope.js'

const DESCRIPTION =
  'Search for existing content on the same topic and extract each piece\'s structure. '
  + 'Call this directly, never inside run_code — a sub-dispatched call records no trajectory.'

export function researchTool() {
  return defineTool({
    name: 'metaboard_research',
    description: DESCRIPTION,
    parameters: {
      subject: {
        type: 'string', required: true,
        description: 'Stable topic id, e.g. topic:city-night-run. Reuse it across every call for this topic.',
      },
      query: { type: 'string', required: true, description: 'What to search for.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          error: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                structure: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error === undefined
          ? `Found ${value.count} pieces on the same topic.`
          : `Search failed: ${value.error}`,
      }],
      presentationMeta: (args, value) => /** @type {any} */ (makeMeta({
        subject: args.subject,
        kind: 'research',
        payload: value,
      })),
    },
    async execute(args, _exec) {
      try {
        // 第一阶段用固定桩数据:本轮验的是轨迹装配,不是检索质量。
        return { count: 3, sources: STUB_SOURCES }
      } catch (error) {
        return { count: 0, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

const STUB_SOURCES = [
  { title: '凌晨四点的城市属于谁', structure: ['钩子', '冲突', '反转'] },
  { title: '我用夜跑治好了失眠', structure: ['数据开场', '案例', '呼吁'] },
  { title: '夜跑装备到底要花多少钱', structure: ['清单', '价格锚点'] },
]
