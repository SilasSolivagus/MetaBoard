import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readOps, fold, opWork, STATUS_LABEL, LEGACY_STATUS } from '../store/works.mjs'
import { readProjectOps, foldProjects } from '../store/projects.mjs'
import { collectEvents } from '../store/sessions.mjs'
import { mergeTimeline } from '../store/timeline.mjs'

// fileURLToPath 而非 URL.pathname:后者不做百分号解码,路径里有空格或非 ASCII 就会断。
// 这条在 test/harness.mjs 里已经栽过一次。
const SP = fileURLToPath(new URL('.', import.meta.url))

/**
 * 从真实的库里读出看板。
 *
 * 这里不自己拼时间线 —— mergeTimeline 是 `metaboard show` 用的同一个函数,
 * 界面和命令行必须看到同一条线。各拼一份就是这个项目栽过三次的那个形状。
 *
 * 形状要和原来的 data.json 一致:{ id: { id, title, status, actor, project, line } }。
 * 少一个 demo 字段 —— 那是编出来的演示数据才有的角标,真数据没有。
 */
async function loadBoard() {
  const ops = readOps()
  const works = fold(ops)
  const projects = foldProjects(readProjectOps())
  /** @type {Record<string, any>} */
  const out = {}
  for (const w of works.values()) {
    const mine = ops.filter((o) => opWork(o) === w.id)
    out[w.id] = {
      id: w.id,
      title: w.title,
      status: w.status,
      actor: w.actor,
      // 项目在卡片上显示的是名字不是 id。项目没了(被外部改过日志)就退回显示 id,
      // 不假装它不存在。
      project: w.project === undefined ? undefined : (projects.get(w.project)?.name ?? w.project),
      // 归档要带出来。CLI 的 ls 默认不显示归档项,看板也不该把一个已归档的
      // 工作项摆在「处理中」列里当活儿看。
      archivedAt: w.archivedAt,
      line: mergeTimeline(mine, await collectEvents(w.id)),
    }
  }
  return out
}

const data = await loadBoard()

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const hhmm = (ms) => { const d = new Date(ms); const p = n => String(n).padStart(2,'0'); return `${p(d.getHours())}:${p(d.getMinutes())}` }

/**
 * 段落配对 + 段内逐字比对。
 *
 * 先按段落精确匹配做过一版:只要改一个字整段就算「新的」,结果满屏标红,
 * 等于什么都没说。所以改成两步:先把改后稿的每一段配到初稿最像的那一段,
 * 再在段内做字符级 LCS,只标真正插进去的字。配不上的段才算整段新增。
 */
function lcsTable(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  return dp
}
/** b 相对 a 的插入片段。返回 [{t, ins}]。 */
function charDiff(a, b) {
  const dp = lcsTable(a, b)
  const out = []
  let i = 0, j = 0
  const push = (t, ins) => {
    if (!t) return
    const last = out[out.length - 1]
    if (last && last.ins === ins) last.t += t
    else out.push({ t, ins })
  }
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(b[j], false); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else { push(b[j], true); j++ }
  }
  while (j < b.length) { push(b[j], true); j++ }
  return out
}
const paras = (t) => (t || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
/** 相似度:LCS 长度 / 较长者长度。 */
function sim(a, b) {
  if (!a.length || !b.length) return 0
  return lcsTable(a, b)[0][0] / Math.max(a.length, b.length)
}
function paraDiff(aText, bText) {
  const A = paras(aText), B = paras(bText)
  const usedA = new Set()
  const after = B.map((b) => {
    let best = -1, bestScore = 0
    A.forEach((a, k) => {
      if (usedA.has(k)) return
      const sc = sim(a, b)
      if (sc > bestScore) { bestScore = sc; best = k }
    })
    if (bestScore < 0.4) return { t: b, whole: true, parts: [{ t: b, ins: true }] }
    usedA.add(best)
    return { t: b, whole: false, parts: charDiff(A[best], b), pair: best }
  })
  const before = A.map((a, k) => ({ t: a, gone: !usedA.has(k) }))
  return { before, after }
}

/* 状态标签不再在这里抄一份 —— 直接用 store 的 STATUS_LABEL。
   HANDOFF 里记着「标签硬编码在三处」,这是其中一处,接真数据时顺手收掉。
   LEGACY_STATUS 一并过一遍:真实日志里留着 initial 这样的早期值,
   照直印会出现一个用户从没见过的英文词。 */
/* kind 的标签。内容生产与工单是两套工具,所以是两组 kind —— 状态共用,工具各自不同,
   这正是「换个领域只换工具」那句话的形状。 */
const KLABEL = { research:'素材', draft:'初稿', review:'评审', revise:'改稿',
  triage:'定位', repro:'复现', fix:'修复', verify:'验证', release:'发版', reply:'回复' }
const sl = (x) => { const now = LEGACY_STATUS[x] ?? x; return STATUS_LABEL[now] ?? now }

function describe(e) {
  const p = e.payload ?? {}
  if (e.source === 'board') {
    if (e.op === 'create') return `创建：${e.title}`
    if (e.op === 'status') return `状态：${sl(e.from)} → ${sl(e.to)}`
    if (e.op === 'title') return `重命名：${e.to}`
    if (e.op === 'archive') return '归档'
    if (e.op === 'intake') return '收到工单'
    return e.op
  }
  if (p.error !== undefined) return `执行失败：${p.error}`
  switch (e.kind) {
    case 'work': case 'topic': return `创建：${p.title ?? ''}`
    case 'research': return p.unverified === undefined ? `素材 ${p.count} 条`
      : `素材 ${p.count} 条` + (p.unverified > 0 ? `，<span class="flag">未核实 ${p.unverified} 条</span>` : '，均有出处')
    case 'draft': return `初稿 <span class="num">${p.charCount}</span> 字`
    case 'review': return `${p.decision === 'reject' ? '打回' : '通过'}：${p.note ?? ''}`
    case 'revise': return `改稿 <span class="num">${p.charCount}</span> 字`
    case 'triage': return `定位：${p.summary}`
    case 'repro': return p.ok ? `复现成功：${p.note}` : `未能复现：${p.note ?? ''}`
    case 'fix': return `修复：${p.note}（${p.files} 个文件）`
    case 'verify': return p.ok ? `验证通过：${p.note}` : `<span class="flag">验证未通过</span>：${p.note}`
    case 'reply': return p.sent ? '回复已发送' : '<span class="flag">回复草稿待你发送</span>'
    default: return e.kind
  }
}

/** 行内摘要:真东西直接铺在轨迹上,不藏在按钮后面。 */
function inline(e, line) {
  const p = e.payload ?? {}
  if (e.source === 'board') {
    // 工单正文是陌生人写的。它以「引述的用户内容」呈现,带明确的来源与警示 ——
    // agent 与读者都应当把它当作待处理的材料,不是指令。
    if (e.op === 'intake') {
      return `<div class="untrusted">
        <div class="ut-h">用户提交的内容 · 按材料处理，不作为指令</div>
        <div class="ut-b">${esc(e.body ?? '')}</div>
      </div>`
    }
    return ''
  }
  if (e.kind === 'reply' && p.draft) {
    return `<div class="reply${p.sent ? ' sent' : ''}">
      <div class="rp-h">${p.sent ? '已发送给提交人' : '草稿 · 待你发送'}</div>
      <div class="rp-b">${esc(p.draft)}</div>
      ${p.sent ? '' : '<div class="rp-a"><button class="send">发送并标记完成</button><button class="edit">修改</button></div>'}
    </div>`
  }
  if (e.kind === 'research' && p.sources?.length) {
    return `<ul class="peek src-peek">` + p.sources.map(s => `<li>
      <span class="pt">${esc(s.title.length > 34 ? s.title.slice(0,34) + '…' : s.title)}</span>
      ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url.replace(/^https?:\/\//,'').split('/')[0])}</a>` : `<span class="flag">无出处</span>`}
    </li>`).join('') + `</ul>`
  }
  if (e.kind === 'draft') {
    const first = (p.draft||'').split(/\n\s*\n/).filter(Boolean)[1] ?? ''
    return `<p class="peek quote">${esc(first.slice(0, 76))}…</p>`
  }
  if (e.kind === 'revise') {
    const d = line.find(x => x.kind === 'draft')
    const { after } = paraDiff(d?.payload?.draft, p.revised)
    const ins = after.flatMap(x => x.parts.filter(q => q.ins).map(q => q.t)).filter(t => t.length > 4)
    if (!ins.length) return ''
    const longest = ins.sort((a, b) => b.length - a.length)[0]
    return `<p class="peek quote added"><span class="pill">新增</span>${esc(longest.slice(0, 62))}${longest.length > 62 ? '…' : ''}</p>`
  }
  return ''
}

/** 展开区:每种 kind 展开出真东西。 */
function body(e, line) {
  const p = e.payload ?? {}
  if (e.source === 'board') return ''
  if (e.kind === 'research' && p.sources?.length) {
    return `<div class="disclose"><ol class="src">` + p.sources.map(s => `<li>
      <div class="src-t">${esc(s.title)}</div>
      <div class="src-u">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url.replace(/^https?:\/\//,'').slice(0,58))}</a>` : `<span class="flag">未核实 · 无出处</span>`}</div>
      <div class="src-s">${(s.structure||[]).map(x=>`<span>${esc(x)}</span>`).join('<i>›</i>')}</div>
    </li>`).join('') + `</ol></div>`
  }
  if (e.kind === 'draft') return `<div class="disclose"><div class="prose">${(p.draft||'').split(/\n\s*\n/).map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>`
  if (e.kind === 'revise') {
    const d = line.find(x => x.kind === 'draft')
    const { before, after } = paraDiff(d?.payload?.draft, p.revised)
    return `<div class="disclose"><div class="cmp">
      <div><h4>初稿 <span class="num">${d?.payload?.charCount ?? ''}</span></h4>${before.map(x=>`<p class="${x.gone?'gone':''}">${esc(x.t)}</p>`).join('')}</div>
      <div><h4>改后 <span class="num">${p.charCount}</span></h4>${after.map(x=>`<p class="${x.whole?'new':''}">${
        x.parts.map(q=>q.ins?`<ins>${esc(q.t)}</ins>`:esc(q.t)).join('')}</p>`).join('')}</div>
    </div><p class="cmp-note">按段落配对后逐字比对。<b class="new-k">标注部分</b>为改稿新增，浅色段落为已删除。</p></div>`
  }
  return ''
}

/** 签名元素:按真实时间比例排布。gap 用 sqrt 压缩,超过 1 分钟的间隔把真实时长标出来。 */
function gapPx(ms) { return Math.min(150, Math.max(14, Math.sqrt(ms / 1000) * 7)) }
function gapLabel(ms) {
  if (ms < 60000) return ''
  const m = Math.round(ms / 60000)
  return `<div class="gapl"><span>间隔 ${m} 分钟</span></div>`
}

function trail(w) {
  let out = ''
  w.line.forEach((e, i) => {
    const prev = w.line[i - 1]
    if (prev) {
      const d = e.at - prev.at
      out += `<div class="gap" style="height:${gapPx(d)}px">${gapLabel(d)}</div>`
    }
    const b = body(e, w.line)
    const label = KLABEL[e.kind] ?? (e.source === 'board' ? '看板' : '会话')
    out += `<div class="row ${e.source}${b ? ' has' : ''}">
      <time>${hhmm(e.at)}</time>
      <span class="mk"></span>
      <div class="txt">
        <span class="src-tag">${label}</span>
        <span class="d">${describe(e)}</span>
        ${b ? `<button class="more" aria-expanded="false">${e.kind === 'revise' ? '对比全文' : '全文'}</button>` : ''}
      </div>
      ${inline(e, w.line)}
      ${b}
    </div>`
  })
  return out
}

// 看板只放已授权的流水线,照 dashi 的 MAIN_STATUSES。
// 待立项/完成/取消不在这儿 —— 看板不该变成堆场。
const COLS = [
  { k: 'todo',        n: '等待认领', hue: 'gray' },
  { k: 'in_progress', n: '处理中',   hue: 'blue' },
  { k: 'blocked',     n: '遇到阻碍', hue: 'orange' },
  { k: 'in_review',   n: '等你确认', hue: 'purple' },
]
const SECONDARY = [
  { k: 'backlog',  n: '待立项' },
  { k: 'done',     n: '完成' },
  { k: 'canceled', n: '取消' },
]

function mini(w) {
  const t0 = w.line[0].at, span = Math.max(1, w.line.at(-1).at - t0)
  return w.line.map(e =>
    `<i class="${e.source}" style="left:${((e.at - t0) / span * 100).toFixed(1)}%"></i>`).join('')
}

/**
 * 每张卡都要回答「我现在该干什么」。
 *
 * 这一版之前只显示状态,不显示动作 —— 看板成了查看器。更要命的是看板与对话是
 * 两半,而界面上没有任何东西把它们接起来:你看着一张「等待认领」的卡,不知道
 * 下一步该去哪、说什么。所以等待认领这一格直接给出要对 agent 说的那句话。
 */
function nextStep(w) {
  const s = w.status
  if (s === 'backlog') return `<div class="next"><span class="act" data-act="approve" data-id="${w.id}">立项</span>
    <span class="hint">立项后 Agent 才能认领</span></div>`
  if (s === 'todo') return `<div class="next"><span class="say">在 dsh 里说：<b>处理 ${w.id}</b></span></div>`
  if (s === 'in_progress') return `<div class="next"><span class="hint">Agent 正在处理，完成后会转到「等你确认」</span></div>`
  if (s === 'blocked') return `<div class="next"><span class="hint warn">Agent 卡住了，打开看它说了什么</span></div>`
  if (s === 'in_review') {
    const rep = w.line.find((e) => e.kind === 'reply' && !e.payload?.sent)
    return `<div class="next">${rep
      ? `<span class="act" data-act="open" data-id="${w.id}">查看回复草稿</span><span class="hint">你发送后转完成</span>`
      : `<span class="act" data-act="done" data-id="${w.id}">标记完成</span><span class="hint">只有你能标记完成</span>`}</div>`
  }
  return ''
}

function card(w) {
  const n = w.line.filter(e => e.source === 'session').length
  const last = w.line.at(-1).at
  const kinds = [...new Set(w.line.filter(e => e.source === 'session').map(e => e.kind))]
  const unv = w.line.reduce((a, e) => a + (e.payload?.unverified ?? 0), 0)
  const ext = w.actor === 'external'
  return `<button class="card${ext ? ' ext' : ''}" data-id="${w.id}">
    <div class="cid">${w.id}${w.demo ? ' <span class="demo">演示</span>' : ''}
      <span class="proj">${esc(w.project ?? '')}</span></div>
    <div class="ct">${esc(w.title)}</div>
    ${n ? `<div class="mini">${mini(w)}</div>` : '<div class="mini empty"></div>'}
    <div class="cfoot">
      <span class="who ${w.actor}">${
        w.actor === 'external' ? '用户工单' : w.actor === 'user' ? '本人' : 'Agent'}</span>
      ${kinds.map(k => `<span class="chip">${KLABEL[k] ?? k}</span>`).join('')}
      ${unv ? `<span class="chip warn">${unv} 未核实</span>` : ''}
      <span class="when">${n ? hhmm(last) : '无记录'}</span>
    </div>
    ${nextStep(w)}
  </button>`
}

// 归档项不进看板,和 `metaboard ls` 的默认一致。但不能默默吞掉 ——
// 页眉会报数,免得东西不见了还以为没有。
const archived = Object.values(data).filter((w) => w.archivedAt !== undefined)
const works = Object.values(data).filter((w) => w.archivedAt === undefined)

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MetaBoard</title>
<style>
/* ── 系统字体优先。macOS 上 system-ui 就是 SF Pro + 苹方,
      光学字号、字距表、易读性调校都是现成的,自带的比外挂字体更对。 ── */
:root{
  --sans:system-ui,-apple-system,'SF Pro Text','PingFang SC',sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,monospace;

  /* Apple 系统色 */
  --blue:#007AFF; --purple:#AF52DE; --orange:#FF9500; --green:#34C759; --gray:#8E8E93;

  /* 分层背景:成组背景在下,内容层在上 */
  --bg:#F2F2F7; --raised:#FFFFFF;
  --label:rgba(0,0,0,.88); --label2:rgba(60,60,67,.62); --label3:rgba(60,60,67,.34);
  --sep:rgba(60,60,67,.16); --fill:rgba(120,120,128,.10);

  /* 材质与阴影。大面用更厚的模糊与更深的影,小片轻。 */
  --chrome:rgba(242,242,247,.72);
  --sh-card:0 .5px 1px rgba(0,0,0,.04), 0 2px 6px rgba(0,0,0,.05);
  --sh-lift:0 2px 4px rgba(0,0,0,.05), 0 10px 26px rgba(0,0,0,.09);
  --r-card:14px; --r-chip:6px;
}
/* 只做浅色。这是一个明确的取舍,不是漏了 —— 深色需要另一套语义色与材质厚度,
   不是把变量取反就成。等浅色这一套定稳了再说。 */
:root{color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--label);
  font:15px/1.5 var(--sans);letter-spacing:0;-webkit-font-smoothing:antialiased;
  font-optical-sizing:auto}
button{font:inherit;color:inherit;background:none;border:0;padding:0}

/* ── 半透明导航层,内容从下面滚过 ── */
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;
  padding:14px 24px;background:var(--chrome);
  backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%)}
.brand{font-size:17px;font-weight:600;letter-spacing:-.015em}
.brand em{font-style:normal;color:var(--blue)}
.sub{font-size:13px;color:var(--label2);letter-spacing:0}
.top .sp{margin-left:auto}
.back{display:flex;align-items:center;gap:4px;font-size:15px;color:var(--blue);cursor:pointer;
  letter-spacing:-.01em;border-radius:8px;padding:4px 8px;margin:-4px -8px;
  transition:background .15s ease,transform .1s ease}
.back:hover{background:var(--fill)}
.back:active{transform:scale(.97);background:var(--fill)}

/* ── 看板 ── */
.kanban{display:grid;grid-auto-flow:column;grid-auto-columns:312px;gap:18px;
  padding:22px 24px 8px;align-items:start;justify-content:start;overflow-x:auto}
.colh{display:flex;align-items:center;gap:8px;padding:0 4px 10px}
.colh .dot{width:9px;height:9px;border-radius:50%;flex:none}
.colh .nm{font-size:15px;font-weight:600;letter-spacing:-.012em}
.colh .ct2{font-family:var(--mono);font-size:12px;color:var(--label2);margin-left:auto;
  background:var(--fill);border-radius:20px;padding:2px 9px;min-width:26px;text-align:center}
.gray .dot{background:var(--gray)} .blue .dot{background:var(--blue)}
.orange .dot{background:var(--orange)} .purple .dot{background:var(--purple)}
.purple .nm{color:var(--purple)}

.card{display:block;width:100%;text-align:left;background:var(--raised);
  border-radius:var(--r-card);box-shadow:var(--sh-card);padding:15px 16px 13px;margin-bottom:12px;
  cursor:pointer;transition:box-shadow .22s ease,transform .12s cubic-bezier(.2,0,0,1)}
.card:hover{box-shadow:var(--sh-lift)}
/* 反馈在按下那一刻发生,不等松手 */
.card:active{transform:scale(.985)}
.cid{font-family:var(--mono);font-size:11px;color:var(--label3);letter-spacing:.02em}
.demo{border:1px solid var(--sep);border-radius:4px;padding:0 4px;font-size:9.5px;margin-left:4px}
.ct{font-size:16px;font-weight:600;line-height:1.38;letter-spacing:-.014em;margin:5px 0 12px}
.mini{position:relative;height:14px;margin-bottom:12px}
.mini::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1.5px;
  border-radius:1px;background:var(--fill)}
.mini.empty::after{background:repeating-linear-gradient(90deg,var(--sep) 0 3px,transparent 3px 7px)}
.mini i{position:absolute;bottom:0;width:3px;height:8px;border-radius:1.5px;
  display:block;background:var(--label3)}
.mini i.board{background:var(--blue);height:14px;width:3px}
.cfoot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.chip{font-size:12px;color:var(--label2);background:var(--fill);border-radius:var(--r-chip);
  padding:2px 7px;letter-spacing:-.005em}
.chip.warn{color:var(--orange);background:rgba(255,149,0,.12)}
.who{font-size:12px;border-radius:var(--r-chip);padding:2px 7px;letter-spacing:-.005em}
.who.user{color:var(--blue);background:rgba(0,122,255,.11)}
.who.agent{color:var(--label2);background:var(--fill)}
.when{font-family:var(--mono);font-size:11px;color:var(--label3);margin-left:auto}
.next{display:flex;align-items:center;gap:9px;margin-top:11px;padding-top:10px;
  border-top:.5px solid var(--sep)}
.act{font-size:13px;font-weight:500;color:#fff;background:var(--blue);border-radius:7px;
  padding:4px 11px;letter-spacing:-.008em;transition:transform .1s ease,filter .15s ease}
.act:hover{filter:brightness(1.06)}
.act:active{transform:scale(.96)}
.hint{font-size:12px;color:var(--label3);letter-spacing:-.005em}
.hint.warn{color:var(--orange)}
.say{font-size:12.5px;color:var(--label2);letter-spacing:-.005em}
.say b{font-family:var(--mono);font-size:12px;color:var(--blue);background:rgba(0,122,255,.1);
  border-radius:5px;padding:1px 6px;font-weight:500}
.board-empty{margin:0 0 28px;padding:22px 24px;border-radius:14px;
  background:var(--raised);color:var(--dim);max-width:520px}
.board-empty p{margin:0;font-size:15px;color:var(--ink)}
.board-empty .hint{margin-top:6px;font-size:13px;color:var(--dim)}
.board-empty code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  padding:1px 5px;border-radius:5px;background:var(--chip)}
.empty-col{font-size:13px;color:var(--label3);padding:16px;border-radius:var(--r-card);
  background:var(--fill)}
.proj{float:right;font-size:11px;color:var(--label2);background:var(--fill);
  border-radius:5px;padding:1px 6px;letter-spacing:-.005em}
/* 外部工单要看得出是外部的 —— 信任边界在界面上必须可见 */
.card.ext{box-shadow:var(--sh-card),inset 3px 0 0 var(--orange)}
.who.external{color:var(--orange);background:rgba(255,149,0,.12)}
.untrusted{margin:9px 0 3px;border-radius:10px;background:rgba(255,149,0,.07);
  border:1px solid rgba(255,149,0,.22);overflow:hidden}
.ut-h{font-size:11.5px;color:var(--orange);padding:7px 12px 0;letter-spacing:-.005em}
.ut-b{font-size:14px;line-height:1.65;color:var(--label);padding:5px 12px 11px;
  white-space:pre-wrap;max-width:64ch}
.reply{margin:10px 0 3px;border-radius:12px;background:var(--raised);
  box-shadow:var(--sh-card);overflow:hidden;max-width:64ch}
.rp-h{font-size:11.5px;color:var(--blue);padding:10px 14px 0;letter-spacing:-.005em}
.reply.sent .rp-h{color:var(--label3)}
.rp-b{font-size:14px;line-height:1.7;padding:6px 14px 12px;color:var(--label)}
.rp-a{display:flex;gap:8px;padding:0 14px 13px}
.send,.edit{font-size:13px;border-radius:8px;padding:6px 13px;cursor:pointer;
  transition:transform .1s ease,filter .15s ease;letter-spacing:-.008em}
.send{background:var(--blue);color:#fff;font-weight:500}
.send:active,.edit:active{transform:scale(.97)}
.edit{background:var(--fill);color:var(--label)}
/* 其他状态:折叠侧板 + 标签页,不是看板下面一排 */
.drawer{position:fixed;top:0;right:0;bottom:0;width:352px;z-index:20;
  background:var(--chrome);backdrop-filter:blur(30px) saturate(180%);
  -webkit-backdrop-filter:blur(30px) saturate(180%);
  box-shadow:-1px 0 0 var(--sep),-14px 0 40px rgba(0,0,0,.10);
  transform:translateX(100%);transition:transform .34s cubic-bezier(.32,.72,0,1);
  display:flex;flex-direction:column}
.drawer.dw-open{transform:none}
.dw-h{display:flex;align-items:center;gap:10px;padding:16px 18px 12px}
.dw-h .t{font-size:17px;font-weight:600;letter-spacing:-.015em}
.dw-close{margin-left:auto;font-size:15px;color:var(--blue);cursor:pointer;
  border-radius:8px;padding:4px 8px}
.dw-close:hover{background:var(--fill)}
.tabs{display:flex;gap:4px;padding:0 14px 12px}
.tab{font-size:13px;color:var(--label2);border-radius:8px;padding:5px 11px;cursor:pointer;
  letter-spacing:-.006em;transition:background .15s ease}
.tab:hover{background:var(--fill)}
.tab.on{background:var(--raised);color:var(--label);font-weight:600;box-shadow:var(--sh-card)}
.tab .n{font-family:var(--mono);font-size:11px;color:var(--label3);margin-left:5px}
.dw-body{flex:1;overflow:auto;padding:0 14px 24px}
.dw-note{font-size:12.5px;line-height:1.6;color:var(--label2);background:var(--fill);
  border-radius:10px;padding:11px 13px;margin-bottom:12px}
.drawer-trigger{font-size:13px;color:var(--label2);cursor:pointer;border-radius:8px;
  padding:5px 11px;background:var(--fill);letter-spacing:-.006em}
.drawer-trigger:hover{color:var(--label)}

.shelf{padding:8px 24px 64px}
.shelf h3{font-size:13px;font-weight:600;color:var(--label2);letter-spacing:-.005em;
  margin:0 0 12px;padding-top:20px;border-top:.5px solid var(--sep)}
.shelf .rows{display:grid;grid-auto-flow:column;grid-auto-columns:312px;gap:18px;
  justify-content:start;overflow-x:auto}
.shelf .sec{font-size:13px;color:var(--label2);margin-bottom:9px;padding:0 4px}
.gate{font-size:13px;line-height:1.55;color:var(--label2);padding:13px 15px;
  border-radius:var(--r-card);background:var(--fill);margin-bottom:12px}

/* ── 工作项详情。从卡片的位置放大出来,再原路收回。 ── */
.item{display:none;padding:26px 24px 90px;max-width:760px;margin:0 auto;
  transform-origin:var(--ox,50%) var(--oy,0);}
.item.in{display:block;animation:emerge .34s cubic-bezier(.32,.72,0,1)}
@keyframes emerge{from{opacity:0;transform:scale(.965) translateY(6px)}to{opacity:1;transform:none}}
.eyebrow{font-family:var(--mono);font-size:12px;color:var(--label3);letter-spacing:.02em}
h1{font-size:28px;font-weight:700;line-height:1.16;letter-spacing:-.022em;margin:8px 0 14px}
.meta{display:flex;gap:18px;font-size:13px;color:var(--label2);padding-bottom:18px;
  border-bottom:.5px solid var(--sep)}
.meta b{font-weight:600;color:var(--label)}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--label2);margin:16px 0 26px}
.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.legend i.b{background:var(--blue)} .legend i.s{background:var(--label3)}

/* ── 轨迹 ── */
.trail{position:relative;padding-left:78px}
.trail::before{content:'';position:absolute;left:78px;top:8px;bottom:8px;width:1.5px;
  border-radius:1px;background:var(--fill)}
.gap{position:relative}
.gapl{position:absolute;left:0;top:50%;transform:translateY(-50%)}
.gapl span{position:absolute;left:0;transform:translateX(-50%);font-family:var(--mono);
  font-size:11px;color:var(--label3);background:var(--bg);padding:3px 8px;white-space:nowrap;
  border-radius:20px}
.row{position:relative;padding:3px 0 3px 22px}
.row time{position:absolute;left:-78px;width:42px;text-align:right;font-family:var(--mono);
  font-size:12px;color:var(--label3);top:5px}
.mk{position:absolute;left:-5.5px;top:10px;width:11px;height:11px;border-radius:50%;
  background:var(--bg);border:2.5px solid var(--label3);box-sizing:border-box}
.row.board .mk{border-color:var(--blue);background:var(--blue)}
.src-tag{font-size:12px;color:var(--label3);margin-right:9px;letter-spacing:-.005em}
.row.board .src-tag{color:var(--blue)}
.d{font-size:15px;letter-spacing:-.008em}
.num{font-family:var(--mono);font-size:14px;font-weight:600}
.flag{color:var(--orange)}
.more{font-size:13px;color:var(--blue);cursor:pointer;margin-left:10px;border-radius:6px;
  padding:2px 7px;transition:background .15s ease}
.more:hover{background:var(--fill)}
.more:active{transform:scale(.97)}
.peek{margin:7px 0 3px}
.src-peek{list-style:none;padding:0;margin:0}
.src-peek li{display:flex;gap:10px;align-items:baseline;font-size:13px;line-height:1.75;
  color:var(--label2)}
.src-peek a{font-family:var(--mono);font-size:11px;color:var(--label3);text-decoration:none}
.src-peek a:hover{color:var(--blue)}
.quote{font-size:13.5px;line-height:1.7;color:var(--label2);padding-left:12px;
  border-left:2px solid var(--fill);border-radius:1px;max-width:62ch}
.quote.added{border-left-color:var(--blue)}
.pill{font-size:11px;color:var(--blue);background:rgba(0,122,255,.11);border-radius:5px;
  padding:1px 6px;margin-right:8px}
.disclose{display:none;margin:14px 0 6px;padding:18px 20px;background:var(--raised);
  border-radius:var(--r-card);box-shadow:var(--sh-card)}
.row.show .disclose{display:block}
.src{list-style:none;margin:0;padding:0}
.src li{padding:11px 0;border-bottom:.5px solid var(--sep)}
.src li:last-child{border:0;padding-bottom:0}
.src-t{font-size:15px;font-weight:600;letter-spacing:-.01em;margin-bottom:3px}
.src-u{font-family:var(--mono);font-size:11.5px;margin-bottom:6px}
.src-u a{color:var(--blue);text-decoration:none}
.src-s{font-size:13px;color:var(--label2)}
.src-s i{font-style:normal;margin:0 7px;color:var(--label3)}
.prose{font-size:15px;line-height:1.72;max-height:320px;overflow:auto}
.prose p{margin:0 0 1em}
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:26px;font-size:14px;line-height:1.72;
  max-height:360px;overflow:auto}
.cmp h4{font-size:12px;font-weight:600;color:var(--label2);margin:0 0 10px;
  position:sticky;top:0;background:var(--raised);padding-bottom:4px;letter-spacing:0}
.cmp p{margin:0 0 .9em}
.cmp p.new{box-shadow:inset 2px 0 0 var(--blue);padding-left:10px;border-radius:1px}
.cmp p.gone{opacity:.38}
.cmp ins{text-decoration:none;background:rgba(0,122,255,.13);border-radius:3px;padding:1px 2px}
.cmp-note{font-size:12px;color:var(--label3);margin:14px 0 0}
.new-k{color:var(--blue);font-weight:400}

@media (max-width:900px){.kanban,.shelf .rows{grid-auto-flow:row;grid-auto-columns:auto}
  .item{padding:22px 18px 70px}.cmp{grid-template-columns:1fr}}
/* 降低动效:换成不引发前庭反应的淡入,去掉位移与缩放 */
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;transition-duration:.01ms!important}
  .item.in{animation:fade .2s ease}@keyframes fade{from{opacity:0}to{opacity:1}}
  .card:active{transform:none}}
/* 降低透明度:材质变实,去掉模糊 */
@media (prefers-reduced-transparency:reduce){
  .top{background:var(--raised);backdrop-filter:none;-webkit-backdrop-filter:none;
    border-bottom:.5px solid var(--sep)}}
/* 提高对比:实底 + 明确边界 */
@media (prefers-contrast:more){
  :root{--label2:rgba(60,60,67,.86);--label3:rgba(60,60,67,.7);--sep:rgba(0,0,0,.4)}
  .card{border:1px solid var(--sep)}}
:focus-visible{outline:3px solid var(--blue);outline-offset:2px;border-radius:6px}
</style></head><body>
<div class="top">
  <span class="brand">Meta<em>Board</em></span>
  <span class="sub">看板在这里 · 活儿在 dsh 会话里干${archived.length ? ` · 另有 ${archived.length} 个已归档` : ''}</span>
  <span class="sp"></span>
  <button class="drawer-trigger">其他 · ${works.filter(w => SECONDARY.some(c => c.k === w.status)).length}</button>
  <button class="back" style="display:none">‹ 看板</button>
</div>
<div id="board">
${works.some(w => COLS.some(c => c.k === w.status)) ? '' : `<div class="board-empty">
  <p>看板上没有在办的工作项。</p>
  <p class="hint">${(() => {
    const pend = works.filter(w => w.status === 'backlog').length
    const done = works.filter(w => w.status === 'done').length
    if (pend) return `有 ${pend} 个待立项 —— <code>metaboard approve &lt;id&gt;</code> 放行。`
    if (done || archived.length) return '做完的收在右上角「其他」里。要开新的：<code>metaboard new &lt;标题&gt;</code>。'
    return '还没有工作项。<code>metaboard new &lt;标题&gt;</code> 开一个。'
  })()}</p>
</div>`}
<div class="kanban">
  ${COLS.map(c => {
    const inCol = works.filter(w => w.status === c.k)
    return `<div class="${c.hue}"><div class="colh"><span class="dot"></span><span class="nm">${c.n}</span><span class="ct2">${inCol.length}</span></div>
      <div data-col="${c.k}">${inCol.length ? inCol.map(card).join('') : '<div class="empty-col">空</div>'}</div></div>`
  }).join('')}
</div>
</div>
<aside class="drawer" id="drawer">
  <div class="dw-h"><span class="t">其他</span><button class="dw-close">完成</button></div>
  <div class="tabs">
    ${SECONDARY.map((c, i) => `<button class="tab${i === 0 ? ' on' : ''}" data-tab="${c.k}">${c.n}<span class="n">${works.filter(w => w.status === c.k).length}</span></button>`).join('')}
  </div>
  <div class="dw-body">
    ${SECONDARY.map((c, i) => `<div class="pane" data-tab="${c.k}" style="display:${i === 0 ? 'block' : 'none'}">
      ${c.k === 'backlog' ? '<div class="dw-note">这些还没立项。Agent 无权认领，也不会读取其中的内容。立项后进入看板。</div>' : ''}
      ${works.filter(w => w.status === c.k).length
        ? works.filter(w => w.status === c.k).map(card).join('')
        : '<div class="empty-col">空</div>'}
    </div>`).join('')}
  </div>
</aside>
${works.map(w => `<section class="item" data-id="${w.id}">
  <div class="eyebrow">${w.id} · ${sl(w.status)}</div>
  <h1>${esc(w.title)}</h1>
  <div class="meta"><span>创建者 <b>${w.actor === 'user' ? '本人' : 'Agent'}</b></span>
    <span><b>${w.line.length}</b> 条记录</span>
    <span>历时 <b>${((w.line.at(-1).at-w.line[0].at)/60000).toFixed(0)}</b> 分钟</span></div>
  <div class="legend">
    <span><i class="b"></i>看板 · 本人</span>
    <span><i class="s"></i>会话 · Agent</span>
    <span>纵向间距按实际时间比例，间隔超过 1 分钟标注时长。</span>
  </div>
  <div class="trail">${trail(w)}</div>
</section>`).join('')}
<script>
const back = document.querySelector('.back')
// 详情从卡片所在的位置放大出来,再原路收回 —— 出现和消失走同一条路径。
function show(id, origin){
  const board = document.getElementById('board')
  board.style.display = id ? 'none' : 'block'
  document.querySelectorAll('.item').forEach(s => {
    const on = s.dataset.id === id
    s.classList.toggle('in', on)
    if (on && origin) { s.style.setProperty('--ox', origin.x + 'px'); s.style.setProperty('--oy', origin.y + 'px') }
  })
  back.style.display = id ? 'flex' : 'none'
  window.scrollTo(0, 0)
}
document.querySelectorAll('.card').forEach(c => c.addEventListener('click', () => {
  const r = c.getBoundingClientRect()
  show(c.dataset.id, { x: r.left + r.width / 2, y: r.top })
}))
back.addEventListener('click', () => show(null))
const drawer = document.getElementById('drawer')
document.querySelector('.drawer-trigger').addEventListener('click', () => drawer.classList.add('dw-open'))
document.querySelector('.dw-close').addEventListener('click', () => drawer.classList.remove('dw-open'))
// 预览里的动作是真的会改状态的 —— 不能让人对着一个点不动的按钮判断好不好用。
function moveCard(id, to){
  const card = document.querySelector('.card[data-id="' + id + '"]')
  if (!card) return
  const col = document.querySelector('[data-col="' + to + '"]')
  if (!col) return
  card.querySelector('.next')?.remove()
  col.appendChild(card)
  document.querySelectorAll('[data-col]').forEach(c => {
    const n = c.querySelectorAll('.card').length
    const badge = c.previousElementSibling?.querySelector('.ct2')
    if (badge) badge.textContent = n
    const empty = c.querySelector('.empty-col')
    if (empty && n > 1) empty.remove()
  })
}
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('.act')
  if (!a) return
  ev.stopPropagation()
  const id = a.dataset.id
  if (a.dataset.act === 'approve') {
    document.getElementById('drawer').classList.remove('dw-open')
    moveCard(id, 'todo')
    const card = document.querySelector('.card[data-id="' + id + '"]')
    if (card) card.insertAdjacentHTML('beforeend',
      '<div class="next"><span class="say">在 dsh 里说：<b>处理 ' + id + '</b></span></div>')
  } else if (a.dataset.act === 'done') {
    moveCard(id, 'done')
  } else if (a.dataset.act === 'open') {
    const card = document.querySelector('.card[data-id="' + id + '"]')
    const r = card.getBoundingClientRect()
    show(id, { x: r.left + r.width / 2, y: r.top })
  }
}, true)
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.send')
  if (!b) return
  const box = b.closest('.reply')
  box.classList.add('sent')
  box.querySelector('.rp-h').textContent = '已发送给提交人'
  box.querySelector('.rp-a').remove()
  const row = b.closest('.row'); const d = row.querySelector('.d')
  if (d) d.textContent = '回复已发送'
})
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t))
  document.querySelectorAll('.pane').forEach(p => p.style.display = p.dataset.tab === t.dataset.tab ? 'block' : 'none')
}))
document.querySelectorAll('.drawer .card').forEach(c => c.addEventListener('click', () => {
  drawer.classList.remove('dw-open')
  const r = c.getBoundingClientRect()
  show(c.dataset.id, { x: r.left + r.width / 2, y: r.top })
}))
document.querySelectorAll('.more').forEach(b => {
  b.dataset.l = b.textContent
  b.addEventListener('click', () => {
    const r = b.closest('.row'); const on = r.classList.toggle('show')
    b.setAttribute('aria-expanded', on); b.textContent = on ? '收起' : b.dataset.l
  })
})
</script></body></html>`
writeFileSync(SP + 'index.html', html)
console.log('写好', html.length, '字节')
