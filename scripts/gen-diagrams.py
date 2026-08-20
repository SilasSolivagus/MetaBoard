#!/usr/bin/env python3
"""Generate the README diagrams.

Eight files: two diagrams x light/dark x English/Chinese. Colors come from the
DeepSeek Harness theme tokens (packages/client/ui-theme), so the diagrams look
like the product they describe.

    python3 scripts/gen-diagrams.py
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "assets"

THEMES = {
    "light": dict(
        bg="#ffffff", card="#ffffff", stroke="#E3E6EA", rule="#E3E6EA",
        t1="#0F1115", t2="#61666B", t3="#979DA6",
        blue="#4176E6", blueTint="#EDF3FE", rose="#B5657A", roseTint="#FAF1F3",
        grey="#9AA0A8",
    ),
    "dark": dict(
        bg="#151517", card="#232324", stroke="#34343A", rule="#2F2F34",
        t1="#F9FAFB", t2="#ADB2B8", t3="#81858C",
        blue="#679EFE", blueTint="#1C2740", rose="#D19AA2", roseTint="#2C2224",
        grey="#6E767F",
    ),
}

SANS = ("-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', "
        "'PingFang SC', 'Microsoft YaHei', Arial, sans-serif")
MONO = ("'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, "
        "'PingFang SC', monospace")

COPY = {
    "en": {
        "traj_aria": ("A content trajectory: two turns of tool calls with a human "
                      "review between them, and derivation edges showing which sources "
                      "each artifact came from"),
        "arch_aria": ("Architecture: MetaBoard tools and a review writer emit core "
                      "session events; the shared conversation assembler feeds Chat, "
                      "Trajectory and MetaBoard definitions, each rendering its own tab"),
        "traj_title": "A content trajectory",
        "traj_sub": "Same assembler as a coding agent’s trajectory. Different domain.",
        "bands": ["Turn 1 · Draft", "Human review", "Turn 2 · Revise"],
        "kinds": ["INPUT", "RESEARCH", "DRAFT", "REJECT", "REVISE", "PUBLISH"],
        "c_input": "Write a piece on urban night running, for commuters aged 25–35",
        "c_research_sub": "same topic · last 30 days · sources kept in meta.payload",
        "c_draft_sub": "full text in meta.payload",
        "c_reject": "Lede is flat — open with the data. Cut the price list in §3.",
        "c_revise_sub": "diff in meta.payload",
        "c_publish_sub": "Xiaohongshu",
        "stats": ["Li Ming", "1.8s · 20 items", "22.4s · 2,431 words",
                  "Li Ming", "31.2s · +180 / −95", "posted"],
        "edges": ["sources 01 · 02 · 06", "draft v1", "final text"],
        "leg_model": "derived from — model-originated, carried on ",
        "leg_human": "human-originated, carried on ",
        "arch_title": "How it fits together",
        "arch_sub": "Blue is this package. Everything grey is DeepSeek Harness, unmodified.",
        "b_loop": ("Agent loop", ["opens turns and steps"]),
        "b_tools": ("MetaBoard tools",
                    ["research · draft · revise", "domain payload rides on meta"]),
        "b_review": ("Review writer", ["human decisions"]),
        "b_session": ("Session",
                      ["one append-only event log — MetaBoard adds no event type to it"]),
        "b_asm": ("ConversationNodeAssembler",
                  ["match a business id from one event  →  fold state  →  emit view nodes",
                   "a newly loaded older page replays only the contexts whose answer changed"]),
        "b_chat": ("Chat definitions", ["→ Chat tab"]),
        "b_traj": ("Trajectory definitions", ["→ Trajectory tab"]),
        "b_mb": ("MetaBoard definitions", ["→ Content trajectory tab"]),
        "arch_foot": ("Three targets read one event window. Each holds its own state "
                      "and its own nodes; none knows the others exist."),
    },
    "zh": {
        "traj_aria": ("内容轨迹：两个轮次的工具调用，中间夹一次人工评审，"
                      "派生边显示每个产物来自哪些上游"),
        "arch_aria": ("架构：MetaBoard 的工具和评审写入器产生核心会话事件，"
                      "共享的会话装配器供给 Chat、Trajectory、MetaBoard 三套 "
                      "Definition，各自渲染自己的标签页"),
        "traj_title": "内容轨迹",
        "traj_sub": "和编码 agent 的轨迹用同一套装配器，只是换了个领域。",
        "bands": ["轮次 1 · 起稿", "人工评审", "轮次 2 · 改稿"],
        "kinds": ["输入", "检索", "起稿", "打回", "改稿", "发布"],
        "c_input": "写一篇关于城市夜跑的稿子，面向 25–35 岁通勤族",
        "c_research_sub": "同题材近 30 天 · 素材存在 meta.payload 里",
        "c_draft_sub": "全文在 meta.payload 里",
        "c_reject": "开头太平，换成数据开场；第三段的价格清单删掉。",
        "c_revise_sub": "diff 在 meta.payload 里",
        "c_publish_sub": "小红书",
        "stats": ["李明", "1.8s · 20 条", "22.4s · 2431 字",
                  "李明", "31.2s · +180 / −95", "已发布"],
        "edges": ["素材 01 · 02 · 06", "稿件 v1", "终稿"],
        "leg_model": "派生自 —— 模型产出，走 ",
        "leg_human": "人发起，走 ",
        "arch_title": "怎么拼起来的",
        "arch_sub": "蓝色是这个包，灰色全是 DeepSeek Harness，一行没改。",
        "b_loop": ("Agent 循环", ["开合轮次与步骤"]),
        "b_tools": ("MetaBoard 工具",
                    ["检索 · 起稿 · 改稿",
                     "领域载荷挂在 meta 上"]),
        "b_review": ("评审写入器", ["人工决策"]),
        "b_session": ("Session",
                      ["一条 append-only 事件日志 —— "
                       "MetaBoard 没往里加任何事件类型"]),
        "b_asm": ("ConversationNodeAssembler",
                  ["从单个事件抽出业务 ID  →  "
                   "折叠状态  →  产出视图节点",
                   "新加载的旧页只重放答案发生变化的 Context"]),
        "b_chat": ("Chat Definition", ["→ 对话标签页"]),
        "b_traj": ("Trajectory Definition", ["→ 轨迹标签页"]),
        "b_mb": ("MetaBoard Definition", ["→ 内容轨迹标签页"]),
        "arch_foot": ("三个 target 读同一个事件窗口。"
                      "各持各的状态和节点，"
                      "互相不知道对方存在。"),
    },
}


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def head(w, h, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
            f'width="{w}" height="{h}" role="img" aria-label="{esc(label)}">')


def markers(pairs):
    out = ["  <defs>"]
    for name, col in pairs:
        out.append(f'    <marker id="{name}" markerWidth="9" markerHeight="7" '
                   'refX="8" refY="3.5" orient="auto">')
        out.append(f'      <polygon points="0 0, 9 3.5, 0 7" fill="{col}"/>')
        out.append("    </marker>")
    out.append("  </defs>")
    return out


def title_block(c, title, sub):
    return [
        f'  <text x="36" y="48" font-size="19" font-weight="600" '
        f'fill="{c["t1"]}">{esc(title)}</text>',
        f'  <text x="36" y="70" font-size="13" fill="{c["t2"]}">{esc(sub)}</text>',
    ]


# --------------------------------------------------------------------------
# Trajectory
# --------------------------------------------------------------------------

L, R, H = 76, 730, 54
CARD_Y = [118, 188, 258, 360, 462, 532]
ROLES = ["human", "tool", "tool", "human", "tool", "tool"]
MONO_NAMES = [None, "metaboard.research", "metaboard.draft", None,
              "metaboard.revise", "metaboard.publish"]
BAND_Y = [(104, "12:04:11 · 4m12s"), (346, "12:19:38"), (448, "12:21:02 · 1m50s")]
EDGES = [
    ("M 730,226 H 756 V 272 H 734", "blue", 0, (768, 253)),
    ("M 730,298 H 782 V 478 H 734", "blue", 1, (794, 392)),
    ("M 76,394 H 52 V 500 H 72", "rose", None, None),
    ("M 730,508 H 756 V 556 H 734", "blue", 2, (768, 536)),
]


def trajectory(theme, lang):
    c, t = THEMES[theme], COPY[lang]
    zh = lang == "zh"
    subs = [None, t["c_research_sub"], t["c_draft_sub"], None,
            t["c_revise_sub"], t["c_publish_sub"]]
    mains = [t["c_input"], None, None, t["c_reject"], None, None]

    o = head(960, 680, t["traj_aria"])
    o = [o] + markers([("mb-blue", c["blue"]), ("mb-rose", c["rose"])])
    o.append(f'  <style>text{{font-family:{SANS}}} .m{{font-family:{MONO}}}</style>')
    o.append(f'  <rect width="960" height="680" fill="{c["bg"]}"/>')
    o += title_block(c, t["traj_title"], t["traj_sub"])

    for (ry, clock), lbl in zip(BAND_Y, t["bands"]):
        o.append(f'  <line x1="{L}" y1="{ry}" x2="{R}" y2="{ry}" '
                 f'stroke="{c["rule"]}" stroke-width="1"/>')
        o.append(f'  <text x="{L}" y="{ry - 8}" font-size="12.5" font-weight="600" '
                 f'fill="{c["t1"]}">{esc(lbl)}</text>')
        o.append(f'  <text x="{R}" y="{ry - 8}" text-anchor="end" font-size="11" '
                 f'class="m" fill="{c["t3"]}">{esc(clock)}</text>')

    for path, key, li, xy in EDGES:
        col = c[key]
        o.append(f'  <path d="{path}" fill="none" stroke="{col}" stroke-width="1.4" '
                 f'marker-end="url(#mb-{key})"/>')
        if li is not None:
            cls = "" if zh else ' class="m"'
            o.append(f'  <text x="{xy[0]}" y="{xy[1]}" font-size="11"{cls} '
                     f'fill="{col}">{esc(t["edges"][li])}</text>')

    for i, y in enumerate(CARD_Y):
        accent = c["blue"] if ROLES[i] == "tool" else c["rose"]
        tint = c["blueTint"] if ROLES[i] == "tool" else c["roseTint"]
        o.append(f'  <rect x="{L}" y="{y}" width="{R - L}" height="{H}" rx="7" '
                 f'fill="{c["card"]}" stroke="{c["stroke"]}" stroke-width="1"/>')
        o.append(f'  <rect x="{L}" y="{y}" width="3" height="{H}" rx="1.5" fill="{accent}"/>')
        o.append(f'  <rect x="{L + 16}" y="{y + 17}" width="74" height="20" rx="4" fill="{tint}"/>')
        kcls = ' font-size="11"' if zh else ' font-size="9.5" class="m" letter-spacing="0.7"'
        o.append(f'  <text x="{L + 53}" y="{y + 31}" text-anchor="middle"{kcls} '
                 f'fill="{accent}">{esc(t["kinds"][i])}</text>')
        tx = L + 108
        if MONO_NAMES[i]:
            o.append(f'  <text x="{tx}" y="{y + 24}" font-size="12.5" class="m" '
                     f'fill="{c["t1"]}">{esc(MONO_NAMES[i])}</text>')
            o.append(f'  <text x="{tx}" y="{y + 41}" font-size="11" '
                     f'fill="{c["t3"]}">{esc(subs[i])}</text>')
        else:
            o.append(f'  <text x="{tx}" y="{y + 32}" font-size="13" '
                     f'fill="{c["t1"]}">{esc(mains[i])}</text>')
        o.append(f'  <text x="{R - 16}" y="{y + 32}" text-anchor="end" font-size="11" '
                 f'class="m" fill="{c["t3"]}">{esc(t["stats"][i])}</text>')

    ly, lx2 = 622, 470 if zh else 500
    o.append(f'  <line x1="36" y1="{ly - 22}" x2="924" y2="{ly - 22}" '
             f'stroke="{c["rule"]}" stroke-width="1"/>')
    o.append(f'  <path d="M 36,{ly} H 66" fill="none" stroke="{c["blue"]}" '
             'stroke-width="1.4" marker-end="url(#mb-blue)"/>')
    o.append(f'  <text x="76" y="{ly + 4}" font-size="11.5" fill="{c["t2"]}">'
             f'{esc(t["leg_model"])}<tspan class="m" fill="{c["t1"]}">tool/result.meta</tspan></text>')
    o.append(f'  <path d="M {lx2},{ly} H {lx2 + 30}" fill="none" stroke="{c["rose"]}" '
             'stroke-width="1.4" marker-end="url(#mb-rose)"/>')
    o.append(f'  <text x="{lx2 + 40}" y="{ly + 4}" font-size="11.5" fill="{c["t2"]}">'
             f'{esc(t["leg_human"])}<tspan class="m" fill="{c["t1"]}">user/message</tspan></text>')
    o.append("</svg>")
    return "\n".join(o)


# --------------------------------------------------------------------------
# Architecture
# --------------------------------------------------------------------------

BOXES = [
    (36, 106, 240, 68, "dsh", "b_loop"),
    (300, 106, 360, 68, "mb", "b_tools"),
    (684, 106, 240, 68, "mb", "b_review"),
    (36, 230, 888, 58, "dsh", "b_session"),
    (36, 338, 888, 66, "dsh", "b_asm"),
    (36, 450, 296, 58, "dsh", "b_chat"),
    (356, 450, 296, 58, "dsh", "b_traj"),
    (676, 450, 248, 58, "mb", "b_mb"),
]
ARROWS = [
    (156, 174, 230, "grey", "turn/start · step/start"),
    (480, 174, 230, "blue", "tool/call + tool/result.meta"),
    (804, 174, 230, "blue", "user/message"),
    (480, 288, 338, "grey", None),
    (184, 404, 450, "grey", None),
    (504, 404, 450, "grey", None),
    (800, 404, 450, "blue", None),
]


def architecture(theme, lang):
    c, t = THEMES[theme], COPY[lang]
    o = [head(960, 600, t["arch_aria"])]
    o += markers([("ar-blue", c["blue"]), ("ar-grey", c["grey"])])
    o.append(f'  <style>text{{font-family:{SANS}}} .m{{font-family:{MONO}}}</style>')
    o.append(f'  <rect width="960" height="600" fill="{c["bg"]}"/>')
    o += title_block(c, t["arch_title"], t["arch_sub"])

    for x, y1, y2, key, lbl in ARROWS:
        col = c[key]
        o.append(f'  <path d="M {x},{y1} V {y2}" fill="none" stroke="{col}" '
                 f'stroke-width="1.4" marker-end="url(#ar-{key})"/>')
        if lbl:
            o.append(f'  <text x="{x + 11}" y="{(y1 + y2) // 2 + 4}" font-size="10.5" '
                     f'class="m" fill="{col}">{esc(lbl)}</text>')

    for x, y, w, h, owner, key in BOXES:
        title, subs = t[key]
        accent = c["blue"] if owner == "mb" else c["grey"]
        tag = "MetaBoard" if owner == "mb" else "dsh"
        o.append(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="7" '
                 f'fill="{c["card"]}" stroke="{c["stroke"]}" stroke-width="1"/>')
        o.append(f'  <rect x="{x}" y="{y}" width="3" height="{h}" rx="1.5" fill="{accent}"/>')
        o.append(f'  <text x="{x + 20}" y="{y + 27}" font-size="13.5" font-weight="600" '
                 f'fill="{c["t1"]}">{esc(title)}</text>')
        o.append(f'  <text x="{x + w - 16}" y="{y + 25}" text-anchor="end" font-size="9.5" '
                 f'class="m" letter-spacing="0.5" fill="{accent}">{tag}</text>')
        for i, s in enumerate(subs):
            o.append(f'  <text x="{x + 20}" y="{y + 46 + i * 16}" font-size="11" '
                     f'fill="{c["t3"]}">{esc(s)}</text>')

    o.append(f'  <line x1="36" y1="546" x2="924" y2="546" stroke="{c["stroke"]}" stroke-width="1"/>')
    o.append(f'  <text x="36" y="570" font-size="12" fill="{c["t2"]}">{esc(t["arch_foot"])}</text>')
    o.append("</svg>")
    return "\n".join(o)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for lang in ("en", "zh"):
        suffix = "" if lang == "en" else "-zh"
        for theme in ("light", "dark"):
            for name, fn in (("trajectory", trajectory), ("architecture", architecture)):
                path = OUT / f"{name}{suffix}-{theme}.svg"
                path.write_text(fn(theme, lang), encoding="utf-8")
                print("wrote", path.relative_to(OUT.parent.parent))


if __name__ == "__main__":
    main()
