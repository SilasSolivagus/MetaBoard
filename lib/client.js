window.__ModuleLoader__.load({
  id: "metaboard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var el = React.createElement;

    var inject = ["slots", "conversationEvents", "conversationViews"];

    // ── 信封判据 ──
    // 与 lib/envelope.js 同源。工厂形态没有构建步骤,无法 import 兄弟文件,
    // 只能内联一份;test/definitions.test.js 把两份实现跑同一张行为表比对。
    var KINDS = ["topic", "research", "draft", "revise", "review", "publish"];

    function isMetaBoardMeta(value) {
      if (typeof value !== "object" || value === null) return false;
      return typeof value.subject === "string"
        && typeof value.kind === "string"
        && KINDS.indexOf(value.kind) !== -1
        && "payload" in value;
    }

    function hasPayloadError(payload) {
      return typeof payload === "object" && payload !== null && payload.error !== undefined;
    }

    // R19:传输失败有两个互相独立的落点,必须都看。
    // dsh-tools 的 toolErrorResult 只在 result.error?.info 存在时才写出 data.error
    // (lib/index.js:3483 的 `...info ? { info } : {}`),而 ToolArgsError 没有 info——
    // 参数校验失败的事件因此根本没有 data.error,失败只写在结果内容块的 isError 上。
    // 只看 d.error 会把「模型漏传必填参数」这类失败渲染成一行绿的。
    function hasTransportError(data) {
      if (data.error !== undefined) return true;
      var message = data.message;
      var block = message && message.content && message.content[0];
      return block !== undefined && block !== null && block.isError === true;
    }

    function matchMetaBoardEvent(event, target) {
      if (target === "review") {
        if (event.type !== "user/message") return null;
        var source = event.data && event.data.source;
        if (!source || source.kind !== "plugin" || source.plugin !== "metaboard") return null;
        return { id: String(event.seq), role: "start" };
      }
      if (event.type === "tool/call") {
        var name = event.data && event.data.name;
        if (typeof name !== "string" || name.indexOf("metaboard_") !== 0) return null;
        return { id: String(event.data.callId), role: "start" };
      }
      if (event.type === "tool/result") {
        var message = event.data && event.data.message;
        var block = message && message.content && message.content[0];
        if (!block || block.type !== "tool-result") return null;
        return { id: String(block.toolCallId), role: "update" };
      }
      return null;
    }

    // ── Definition:MetaBoard 工具调用 ──
    var callDefinition = {
      kind: "metaboard-call",
      target: "metaboard",
      match: function (event) { return matchMetaBoardEvent(event, "call"); },
      start: function (_context, match) {
        var d = match.event.data;
        return {
          callId: String(d.callId),
          tool: d.name,
          turn: d.turn,
          step: d.step,
          startedAt: match.event.time,
          status: "running",
        };
      },
      update: function (context, match) {
        var d = match.event.data;
        var next = Object.assign({}, context.state, { endedAt: match.event.time });
        // 没有信封的结果照样收尾,只是没有业务内容可填:参数校验失败、
        // 子派发、崩溃补齐三条路径都会走到这里。不收尾这一行会永远停在 running。
        if (!isMetaBoardMeta(d.meta)) {
          next.status = hasTransportError(d) ? "failed" : "done";
          return next;
        }
        next.subject = d.meta.subject;
        next.contentKind = d.meta.kind;
        next.derivedFrom = d.meta.derivedFrom || [];
        next.payload = d.meta.payload;
        // status 说的是这件活儿成没成,不是传输通没通。四个工具都刻意不抛错
        // (失败要留住信封),业务失败因此表现为「传输层没报错,但 payload.error 有值」。
        // 三种证据任一成立就是 failed;要区分是哪一种,payload.error 与 isError 都还在。
        next.status = hasTransportError(d) || hasPayloadError(d.meta.payload)
          ? "failed"
          : "done";
        return next;
      },
      buildViewNode: function (context) {
        var state = context.state;
        if (state === undefined) return null;
        // R18:这一行曾经对 metaboard_review 返回 null(评审的可见行由
        // reviewDefinition 从 user/message 产出,原意是不让一次评审出两行)。
        // 那个抑制发生在数据层,后果是这个 Context 的节点永远不到达 buildSnapshot,
        // 它的 callId 永远进不了引用索引 —— revise 的 derivedFrom 里存的正是这个
        // callId(review.js 的工具说明就是这么教模型写的),于是那条引用结构性地
        // 永远无法解析,不是「还没加载」。
        // 抑制改到呈现层:这里照常产出节点,只在 data 上标记 referenceOnly,
        // 判据仍取 start 就已知的工具名(不取 update 才填上的 contentKind——
        // 装配器禁止已经产出过节点的 Context 之后收回节点)。Task 8 按这个字段跳过
        // 渲染;buildSnapshot 按 callId 索引到它,引用因此能解析。
        return {
          key: context.key,
          kind: "metaboard-call",
          id: context.id,
          target: "metaboard",
          data: Object.assign({}, state, { referenceOnly: state.tool === "metaboard_review" }),
        };
      },
    };

    // ── Definition:人工评审 ──
    var reviewDefinition = {
      kind: "metaboard-review",
      target: "metaboard",
      match: function (event) { return matchMetaBoardEvent(event, "review"); },
      start: function (_context, match) {
        var d = match.event.data;
        return {
          seq: match.event.seq,
          at: match.event.time,
          // 这条评审消息出自哪次调用。渲染层用它判断评审行是否存在。
          // 旧会话的消息没有这个字段,值为 undefined —— 见 shapeRows 的说明。
          callId: d.source.callId,
          summary: d.source.summary || "",
          text: (d.content || []).map(function (b) { return b.text || ""; }).join(""),
        };
      },
      update: function (context) { return context.state; },
      buildViewNode: function (context) {
        if (context.state === undefined) return null;
        return {
          key: context.key,
          kind: "metaboard-review",
          id: context.id,
          target: "metaboard",
          data: context.state,
        };
      },
    };

    // ── 快照装配:derivedFrom 在这里按 callId 解析,不走 reader ──
    // reader.previous(kind) 在 miss 时记一条窗口缺口依赖,并在 prepend 时把整条链
    // 重放一遍。derivedFrom 的值从不改变,只是目标有时还没加载进当前窗口,所以在
    // 这里按 id 建一次性的 Map 解析更便宜:一次 unresolved 的代价,换掉每次向前
    // 翻页都重放整条血缘链。
    //
    // 未解析的引用渲染成未解析:不 fetch、不回退到 reader、不隐藏这一行。
    function buildSnapshot(nodes) {
      var byCall = {};
      nodes.forEach(function (n) {
        // referenceOnly 的行(R18:metaboard_review 的工具调用)照常被索引 ——
        // 它存在的意义就是让别的行能引用到它;是否渲染是 Task 8 的呈现层决定。
        if (n.kind === "metaboard-call") byCall[n.id] = n;
      });
      var rows = nodes.map(function (n) {
        if (n.kind !== "metaboard-call") return n;
        // 没有信封的行(contentKind === undefined)也要能装出 refs:derivedFrom
        // 本就不存在,(... || []) 让它变成一个空引用列表,而不是让这一行消失。
        var from = (n.data.derivedFrom || []).map(function (id) {
          var t = byCall[id];
          return t === undefined
            ? { id: id, resolved: false }
            : { id: id, resolved: true, kind: t.data.contentKind, tool: t.data.tool };
        });
        return Object.assign({}, n, { refs: from });
      });
      var bySubject = {};
      rows.forEach(function (r) {
        var s = r.data && r.data.subject;
        if (typeof s !== "string") return;
        (bySubject[s] = bySubject[s] || []).push(r.id);
      });
      return { rows: rows, bySubject: bySubject };
    }

    var viewDefinition = {
      target: "metaboard",
      create: function () {
        var current = [];
        return {
          empty: { rows: [], bySubject: {} },
          replace: function (input) {
            current = input.nodes.slice();
            return buildSnapshot(current);
          },
          apply: function (input) {
            input.upserts.forEach(function (node) {
              var i = current.findIndex(function (n) { return n.key === node.key; });
              if (i < 0) current.push(node); else current[i] = node;
            });
            return buildSnapshot(current);
          },
        };
      },
    };

    // ── 行表 ──
    // 快照的行 → 可显示的行。不做虚拟滚动、不做时间轴、不做检视面板:
    // 本阶段验的是装配,不是渲染。
    function shapeRows(snapshot) {
      var rows = (snapshot && snapshot.rows) || [];
      // 哪些调用已经有评审行了。抑制评审的调用行,理由是「它的内容在评审行里」——
      // 那么条件就该是这句话本身,而不是它的旁证。R20 当初写的 status === "done"
      // 只是碰巧等价:评审行来自 execute 里 deferContext 写的消息,execute 跑成了
      // 消息才存在。旁证会随实现漂移,这个索引不会。
      var reviewed = {};
      rows.forEach(function (r) {
        if (r.kind === "metaboard-review" && r.data && r.data.callId !== undefined) {
          reviewed[r.data.callId] = true;
        }
      });
      var out = [];
      rows.forEach(function (r) {
        var d = r.data || {};
        // R18:评审的工具调用行只为让别的行引用得到它而存在,不显示。
        // 判据取 buildViewNode 打的显式标记,不在这里按工具名重新推导。
        //
        // R20:抑制的条件是「替代它的那一行确实存在」。参数校验失败时
        // defineTool 在 execute 之前就抛了 ToolArgsError,deferContext 从未执行,
        // 评审行根本不存在 —— 此时这一行是这次失败在账本上唯一的痕迹,
        // 抑制掉它等于让整次失败消失。
        //
        // 旧会话的评审消息没有 callId,匹配不上,那次评审会显示两行。
        // 这是有意的:多一行是退化,少一行是说谎。
        if (d.referenceOnly && reviewed[d.callId]) return;
        var isReview = r.kind === "metaboard-review";
        out.push({
          key: r.key,
          kind: r.kind,
          // status 已经是「这件活成没成」(R16),这里直接显示,不再从 payload.error 推导。
          // turn / step 是判据 3 的三层里的上两层,必须肉眼可见。
          head: isReview
            ? (d.summary || "人工评审")
            : d.tool + "  ·  " + d.status + "  ·  turn " + d.turn + " / step " + d.step,
          // M2:解析到的目标不一定有信封(contentKind 为 undefined),那样会渲染出
          // 字面量 "undefined(call_xxx)"。退到 start 就已知的工具名。
          //
          // 审查当初给的可达路径是「上游被 run_code 子派发,presentationMeta 不执行」。
          // 实测下来那条路径不成立:子派发的调用产出的是 tool/code-dispatch /
          // tool/code-dispatch-start,不是 tool/call / tool/result,match 从不认领,
          // 所以它根本不产出节点 —— 下游引用它显示成「未解析」,那是对的。
          // (另外这个 profile 的工具清单里也没有 run_code。)
          // 所以这一行现在守的是一个没有已知可达路径的洞。留着是因为它一行、
          // 零成本,而它防的正是本项目最典型的失败类别:账本不崩,只是说了句假话。
          refs: (r.refs || []).map(function (f) {
            if (!f.resolved) return f.id + "(未解析)";
            return (f.kind || f.tool) + "(" + f.id + ")";
          }),
          // 两种行的 data 形状不同:调用行有 payload,评审行只有 summary/text。
          // payload 缺失说明这次调用在产出信封之前就失败了(参数校验、子派发、
          // 崩溃补齐),这一行照样要出现,只是没有业务内容可填。
          body: isReview
            ? (d.text || "")
            : (d.payload === undefined ? "(此次调用没有信封)" : JSON.stringify(d.payload, null, 2)),
        });
      });
      return out;
    }

    function MetaBoardView(props) {
      // 标准套件的 useSession 已被 runtime 收窄到会话快照,订阅由它负责——
      // 取一次 getSnapshot() 拿到的是死值,追加的行不会重新渲染。
      var snapshot = props.useSession(function (s) { return s.views.get("metaboard"); });
      var rows = shapeRows(snapshot);
      return el("div", { style: { padding: 16, fontSize: 13 } },
        rows.length === 0
          ? el("div", { style: { opacity: 0.55 } }, "本会话还没有 MetaBoard 记录")
          : rows.map(function (r) {
              return el("div", {
                key: r.key,
                style: {
                  borderLeft: "3px solid " + (r.kind === "metaboard-review" ? "#B5657A" : "#4176E6"),
                  padding: "6px 12px", marginBottom: 6,
                  background: "var(--dsw-alias-bg-layer-2)",
                },
              },
                el("div", { style: { fontFamily: "var(--ds-font-family-code)" } }, r.head),
                r.refs.length === 0 ? null : el("div", { style: { opacity: 0.55, fontSize: 11 } },
                  "derivedFrom: " + r.refs.join(", ")),
                el("pre", {
                  style: { fontSize: 11, opacity: 0.7, maxHeight: 120, overflow: "auto", margin: "6px 0 0" },
                }, r.body)
              );
            })
      );
    }

    function apply(ctx) {
      ctx.conversationEvents.register(callDefinition);
      ctx.conversationEvents.register(reviewDefinition);
      ctx.conversationViews.register(viewDefinition);

      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          { name: "conversation.view", id: "metaboard", order: 20, label: "内容轨迹" },
          MetaBoardView
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
