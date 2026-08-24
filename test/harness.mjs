// @ts-check
/**
 * 测试共用的加载与重放件。
 *
 * 抽出来是因为对账测试(reconciliation.test.js)要和 definitions.test.js 跑同一套
 * 加载路径 —— 两份各自实现的话,「两半形状一致」这件事本身就会漂移,而这正是
 * 本项目栽过三次的地方。
 *
 * 这里没有断言,只有把生产代码跑起来的手段:工厂形态的 client 半、真装配器、
 * 真 view builder、真渲染组件。测试文件负责断言。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// fileURLToPath 而非 new URL(...).pathname:后者不做百分号解码,检出路径里只要有
// 空格或非 ASCII,readFileSync 就会失败。
import { fileURLToPath } from 'node:url'
import * as cordis from '@deepseek-ai/cordis'

/** buildSnapshot 不读 timeline,给个空的就够了。 */
export const TIMELINE = { turnOrder: [], turns: new Map() }

/** @param {string} path @param {Record<string, unknown>} modules */
export function loadFactoryBundle(path, modules) {
  /** @type {any} */
  let captured
  // 在本 realm 里求值,不用 vm:跨 realm 的对象原型不同,assert.deepEqual 会
  // 把结构相同的结果判成不相等。
  const load = new Function('window', readFileSync(path, 'utf8') + `\n//# sourceURL=${path}`)
  load({ __ModuleLoader__: { load: (/** @type {any} */ m) => { captured = m } } })
  assert.ok(captured !== undefined, `${path} 没有调用 window.__ModuleLoader__.load`)
  return captured.factory((/** @type {string} */ id) => {
    if (!(id in modules)) throw new Error(`未打桩的 require: ${id}`)
    return modules[id]
  })
}

export function loadDefinitions() {
  const half = loadFactoryBundle(fileURLToPath(new URL('../lib/client.js', import.meta.url)), {
    react: { createElement: () => null },
  })
  /** @type {any[]} */
  const registered = []
  /** @type {any[]} */
  const views = []
  /** @type {any} */
  const ctx = {
    conversationEvents: { register: (/** @type {any} */ d) => { registered.push(d); return () => {} } },
    conversationViews: { register: (/** @type {any} */ d) => { views.push(d); return () => {} } },
    slots: { inject: () => {}, register: () => () => {} },
  }
  half.apply(ctx)
  const byKind = new Map(registered.map((d) => [d.kind, d]))
  return {
    inject: half.inject,
    call: byKind.get('metaboard-call'),
    review: byKind.get('metaboard-review'),
    view: views[0],
  }
}

export function loadAssembler() {
  const runtime = loadFactoryBundle(
    fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js', import.meta.url)),
    {
      '@deepseek-ai/cordis': cordis,
      // 装配器不碰它,给个不会在求值期抛的桩就够了
      '@deepseek-ai/dsh-client-ui-slots': new Proxy({}, { get: () => class {} }),
    },
  )
  return runtime.ConversationNodeAssembler
}

/** 把两个 Definition 接上真装配器,view 端用真正注册的 ConversationViewDefinition
 * (而不是 harness() 里那个只收集节点的桩),这样 buildSnapshot 真的跑起来。 */
export function harnessWithRealView() {
  const Assembler = loadAssembler()
  const { call, review, view } = loadDefinitions()
  const builder = view.create()
  let snapshot = builder.empty
  const views = {
    entries: () => [{
      target: 'metaboard',
      create: () => ({
        empty: builder.empty,
        replace: (/** @type {any} */ input) => { snapshot = builder.replace(input); return snapshot },
        apply: (/** @type {any} */ input) => { snapshot = builder.apply(input); return snapshot },
      }),
    }],
  }
  const events = { entries: () => [call, review], fallbackEntry: () => undefined }
  const asm = new Assembler(events, views)
  asm.replaceWindow([], false)
  asm.flush()
  return { asm, snapshot: () => snapshot }
}

/** 捕获注册进 conversation.view 的组件,react.createElement 记成朴素对象。 */
export function loadLedgerView() {
  const half = loadFactoryBundle(fileURLToPath(new URL('../lib/client.js', import.meta.url)), {
    react: {
      createElement: (/** @type {any} */ type, /** @type {any} */ props, /** @type {any[]} */ ...children) =>
        ({ type, props, children }),
    },
  })
  /** @type {any} */
  let component
  /** @type {any} */
  const ctx = {
    conversationEvents: { register: () => () => {} },
    conversationViews: { register: () => () => {} },
    slots: {
      inject: (/** @type {string} */ _name, /** @type {() => void} */ fn) => { fn() },
      register: (/** @type {any} */ _spec, /** @type {any} */ comp) => { component = comp; return () => {} },
    },
  }
  half.apply(ctx)
  assert.ok(component !== undefined, 'conversation.view 没有注册组件')
  return component
}

/** 用一份快照渲染行表,返回渲染树。 */
export function render(/** @type {any} */ snapshot) {
  const View = loadLedgerView()
  return View({
    useSession: (/** @type {(s: any) => any} */ select) =>
      select({ views: new Map([['metaboard', snapshot]]) }),
  })
}

/** 渲染树里的全部文本,按出现顺序。 */
export function textOf(/** @type {any} */ node) {
  if (node === null || node === undefined || node === false) return []
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (typeof node === 'string') return [node]
  if (typeof node === 'object' && 'children' in node) return textOf(node.children)
  return [String(node)]
}

/** 行表里的每一行,渲染成一段文本。 */
export function renderedRows(/** @type {any} */ snapshot) {
  /** @type {any[]} */
  const rows = []
  const walk = (/** @type {any} */ n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n === null || typeof n !== 'object' || !('children' in n)) return
    if (n.props && n.props.key !== undefined) rows.push(textOf(n).join('\n'))
    else walk(n.children)
  }
  walk(render(snapshot))
  return rows
}

/**
 * 行表里的每一行,连同它的 key。key 由生产代码产出(node.key),不是测试拼的 ——
 * 对账要靠它把「账本上可见的行」对回「日志里的调用」,这个对应关系必须来自
 * 被测代码本身,否则对账对的是测试自己的想象。
 * @param {any} snapshot
 * @returns {{ key: string, text: string }[]}
 */
export function renderedRowEntries(snapshot) {
  /** @type {{ key: string, text: string }[]} */
  const rows = []
  const walk = (/** @type {any} */ n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n === null || typeof n !== 'object' || !('children' in n)) return
    if (n.props && n.props.key !== undefined) rows.push({ key: String(n.props.key), text: textOf(n).join('\n') })
    else walk(n.children)
  }
  walk(render(snapshot))
  return rows
}

/**
 * 把一串真实事件按顺序喂进真装配器,返回快照与渲染出的行。
 *
 * 逐条 flush 而不是一次灌完:真实会话里事件就是一条一条到的,而增量路径
 * (apply)和全量路径(replace)在装配器里走的是不同分支。一次灌完只会验到其中一条。
 * @param {any[]} events
 */
export function replay(events) {
  const h = harnessWithRealView()
  for (const event of events) {
    h.asm.append({ event, view: undefined })
    h.asm.flush()
  }
  const snapshot = h.snapshot()
  return { snapshot, entries: renderedRowEntries(snapshot), texts: renderedRows(snapshot) }
}
