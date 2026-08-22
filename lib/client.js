window.__ModuleLoader__.load({
  id: "metaboard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var el = React.createElement;

    var inject = ["slots", "conversationEvents", "conversationViews", "sessions"];

    // ── 信封判据 ──
    // 与 lib/envelope.js 同源。工厂形态没有构建步骤,无法 import 兄弟文件,
    // 只能内联一份;test/definitions.test.js 把两份实现跑同一张行为表比对。
    var KINDS = ["research", "draft", "revise", "review", "publish"];

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
          next.status = d.error === undefined ? "done" : "failed";
          return next;
        }
        next.subject = d.meta.subject;
        next.contentKind = d.meta.kind;
        next.derivedFrom = d.meta.derivedFrom || [];
        next.payload = d.meta.payload;
        // status 说的是这件活儿成没成,不是传输通没通。四个工具都刻意不抛错
        // (失败要留住信封),业务失败因此表现为「没有 d.error,但 payload.error 有值」。
        // 只看 d.error 会把失败的活儿渲染成一行绿的。payload.error 仍在,
        // 需要区分传输失败与业务失败时可以再取。
        next.status = d.error === undefined && !hasPayloadError(d.meta.payload)
          ? "done"
          : "failed";
        return next;
      },
      buildViewNode: function (context) {
        var state = context.state;
        if (state === undefined) return null;
        // 评审的可见行由 reviewDefinition 从 user/message 产出;这里再产出一行
        // 就会一次评审两行。判据取 start 就已知的工具名,不能取 update 才填上的
        // contentKind —— 装配器禁止已经产出过节点的 Context 之后收回节点。
        if (state.tool === "metaboard_review") return null;
        return {
          key: context.key,
          kind: "metaboard-call",
          id: context.id,
          target: "metaboard",
          data: state,
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

    function apply(ctx) {
      ctx.conversationEvents.register(callDefinition);
      ctx.conversationEvents.register(reviewDefinition);

      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          { name: "conversation.view", id: "metaboard", order: 20, label: "内容轨迹" },
          function () {
            return el("div", { style: { padding: 16 } }, "MetaBoard 已加载");
          }
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
