window.__ModuleLoader__.load({
  id: "metaboard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var el = React.createElement;

    var inject = ["slots"];

    function apply(ctx) {
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
