// @ts-check
/**
 * 把两条线并成一条:MetaBoard 的状态变更(C 类日志)与 dsh 的工作事件(信封)。
 *
 * 这是整个项目立论的落点。参照项目 dashi-taskboard 有三本账 —— tasks 表存当前值、
 * task_activities 表存字段审计、ai_chat_events 存会话记录 —— 彼此不通,所以你永远
 * 看不到「这次改稿是在评审打回之后、状态改成 revising 之前发生的」。
 *
 * 这里能并,是因为两边都是只追加的事件:C 类日志天生是变更流(store/works.mjs 选这个
 * 形态就是为了这一刻),dsh 的会话本来就是事件流。剩下的只是按时间戳排序。
 */

/**
 * 一条时间线条目的人话摘要。payload 的形状按 kind 不同,认识的就说具体的,
 * 不认识的就只报 kind —— 宁可少说,不能瞎说。
 * @param {any} e
 * @returns {string}
 */
export function describe(e) {
  if (e.source === 'board') {
    if (e.op === 'create') return `开工作项：${e.title}`
    if (e.op === 'status') return `状态 ${e.from ?? '?'} → ${e.to}`
    if (e.op === 'title') return `改名为：${e.to}`
    if (e.op === 'comment') return `${e.actor === 'agent' ? 'agent' : '你'}留言：${e.body}`
    if (e.op === 'archive') return '归档'
    return e.op
  }
  const p = e.payload ?? {}
  if (p.error !== undefined) {
    // 失败要显示成失败。账本上最要紧的一条纪律。
    return `${e.kind} 失败：${p.error}`
  }
  switch (e.kind) {
    case 'work':
    case 'topic': return `开工作项：${p.title ?? ''}`
    case 'research': {
      const n = p.count ?? (p.sources?.length ?? 0)
      const u = p.unverified
      return u === undefined ? `素材 ${n} 条` : `素材 ${n} 条（${u} 条无出处）`
    }
    case 'draft': return `写了 ${p.charCount ?? p.draft?.length ?? '?'} 字`
    case 'review': return `${p.decision === 'reject' ? '打回' : '通过'}：${p.note ?? ''}`
    case 'revise': return `改到 ${p.charCount ?? '?'} 字`
    case 'read': return `读了要求（${p.comments?.length ?? 0} 条留言）`
    default: return e.kind
  }
}

/**
 * 合并成一条时间线。
 * @param {any[]} ops 该工作项的 C 类操作(已按 id 过滤)
 * @param {any[]} events 该工作项的会话事件(store/sessions.mjs 的 collectEvents 结果)
 * @returns {any[]} 按时间升序
 */
export function mergeTimeline(ops, events) {
  // 开工作项这件事两边都有记录:C 类日志的 create,和 metaboard_work_create 的信封。
  // 两条都不是多余的 —— 信封让 dsh 的账本不出现「成功但没有信封」的行,C 类日志是
  // 看板状态的权威。但在合并视图里它们是同一件事,显示两遍是噪音。
  // 规则:看板事实以 C 类日志为准,信封条目让位。('topic' 是 'work' 的旧 kind 名。)
  const created = ops.some((o) => o.op === 'create')

  // agent 的自述同理:metaboard_report 既写了 comment 操作又发了信封。
  // 但这里不能按 kind 一刀切 —— 写失败的自述只有信封没有 comment,那条必须看得见。
  // 所以按 callId 对齐:comment 操作记下了是哪次调用写的,只让那一次的信封条目让位。
  // 这和 R21 是同一条纪律:抑制的条件写前提本身(这条 comment 确实落地了),
  // 不写旁证(这次调用看起来成功了)。
  const coveredCalls = new Set(
    ops.filter((o) => o.op === 'comment' && typeof o.callId === 'string').map((o) => o.callId))

  const kept = events.filter((e) => {
    if (created && (e.kind === 'work' || e.kind === 'topic')) return false
    const id = e.payload?.callId ?? e.callId
    if (typeof id === 'string' && coveredCalls.has(id)) return false
    return true
  })

  const entries = [
    ...ops.map((o) => ({ at: Date.parse(o.ts), source: 'board', actor: o.actor, ...o })),
    ...kept.map((e) => ({ ...e, source: 'session' })),
  ]
  // 同一毫秒时让看板动作排在会话事件前面:状态先改、活儿再干,读起来更顺。
  // 这是个呈现选择,不是事实主张 —— 同毫秒本来就没有真实先后。
  entries.sort((a, b) => a.at - b.at || (a.source === 'board' ? -1 : 1))
  return entries
}
