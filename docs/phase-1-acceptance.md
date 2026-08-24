# 第一阶段验收

日期：2026-08-22
dsh 版本：0.1.0-rc.6（`dsh --version`，系统安装，按 Ruling R2'）
启动方式：`NODE_USE_ENV_PROXY=1 dsh --profile metaboard-dev --port 8938`（Ruling R5）
验收会话：`~/.dsh/sessions/--Users-silas-Deepdeep--/session-2d5321a2-cf2a-44ca-98d6-6631559ace17`
（标题「MetaBoard 内容生产流程验证」，subject `topic:task8-accept`）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 仓库外的包能被加载,工具调得到,tab 出现 | 成立 | profile `metaboard-dev` 以 `link:/Users/silas/MetaBoard` 装入，仓库不在 dsh 源码树内。会话里四个工具全部被模型直接调用成功（seq 306/1606/1741/2000）；会话头部出现第三个标签页「内容轨迹」，与「对话」「轨迹」并列。浏览器 console 无插件相关报错。 |
| 2 | 存盘重开轨迹完整,不抛 SessionFormatUnsupportedError | 成立 | 真的杀掉进程重启了三次（PID 51388 → 52189 → 52281 → 54322），每次都重新打开同一个会话。前两次之间账本读数逐字符一致：5 行、渲染文本合计 191,758 字符；第三次重启（R19 修复后）同样完整重放出当时全部 6 行。三份服务端日志 `grep -ci SessionFormat` 均为 0；重启后浏览器 console 只有杀进程窗口期的 `ERR_CONNECTION_REFUSED` / WebSocket 断连，重连后无报错。 |
| 3 | 阶段(turn) → 步骤(step) → 工具调用 三层可见 | 成立（有一处缺口） | 每一行的首行是 `metaboard_draft · done · turn 1 / step 2`，turn、step、工具调用三层都在行上直接可读；实测四次调用分别落在 turn 1 的 step 1/2/3/4，第二轮追问落在 turn 2 step 1，第三轮落在 turn 3 step 1。缺口：人工评审行（来自 `user/message`）没有 turn / step。核对日志原文后确认这不是漏取 —— 那条事件（seq 1747）的 `data` 里就没有 `turn`/`step` 两个字段（`tool/call`、`tool/result` 有，`user/message` 没有）。判据 3 在工具调用行上完整成立，在评审行上缺这两层。 |
| 4 | derivedFrom 解析成引用关系 | 成立 | draft 行显示 `derivedFrom: research(call_00_L120td14XkvDrOdyvDBE1259)`；revise 行显示 `derivedFrom: draft(call_00_YLMRM6abKdeFPmnWrbwe8160), review(call_00_W0yAcq3vxqu5Gv7HxnqF8445)` —— 两条都是 `resolved: true`，其中对 review 的那条正是 R18 修复前结构性不可解析的引用，本次现场确认已解析。模型在无人工喂 id 的情况下自己填对了三处 derivedFrom。 |
| 5 | 50KB 级 meta 进得去出得来 | 成立 | draft 的 `tool/result.meta` 在持久化日志里是 560,596 字节（模型写了约 939 字提纲，工具扩写 200 倍）。两次进程重启后重新打开会话，渲染出的那一行 DOM 文本 190,888 字符 / 560,488 字节，`JSON.parse` 回来 `draft` 字段 187,800 字符、`charCount` 字段与之相符，未被截断（该会话里这个字段还叫 `wordCount`，最终审查指出它数的是字符而 render 对模型说的是 words，已改名）。前序任务在日志层的记录是 93,479 字节，这次把它一路验到了渲染层。 |
| 6 | 失败的调用渲染成完整失败记录,不留 running 僵尸行 | 成立（经 Ruling R19、R20 两次修复后） | **带信封的业务失败：** 行渲染为 `metaboard_revise · failed · turn 3 / step 1`，带 `derivedFrom: draft(...)`，payload 显示 `{"added":0,"removed":0,"callId":"call_00_ET_4ACYILsq4H9baenZEMv43857","error":"injected failure for acceptance criterion 6"}`；日志里该 `tool/result` 的 `isError` 为 false、`data.error` 为空，信封完整（工具没抛异常，这正是 Task 4 的契约）。**缺信封的参数校验失败：** 初次验收时这一半不成立 —— 行虽然收了尾（不是僵尸 running），却被标成 `done`。按 R19 把失败证据从只读 `data.error` 加宽到「`data.error` / `message.content[0].isError` / `payload.error` 三者任一」之后重验：同一批持久化事件重放出来的那一行变成 `metaboard_revise · failed · turn 2 / step 1`，新发起的一次漏参调用（`metaboard_draft` 缺 `outline`，日志 seq 2755，`isError: true`、无 `data.error`、无 `meta`）实时追加为 `metaboard_draft · failed · turn 4 / step 1`。两条路径现在都成立。 **评审工具的同类失败（最终审查发现，按 R20 修复后补验）：** 上面两条证据覆盖的是 `metaboard_revise` 与 `metaboard_draft`，没有覆盖 `metaboard_review` —— 而那恰好是当时唯一失效的一个：它的失败在账本上留下的不是僵尸行，是**零行**。修复后在新会话 `~/.dsh/sessions/--Users-silas-Deepdeep--/session-d7c06d0c-b038-4034-87ca-8c384e01f222` 复验：让模型调 `metaboard_review` 故意漏传必填的 `note`，日志 seq 199 的 `tool/call` args 为 null，seq 200 的 `tool/result` `isError: true`、无 `data.error`、无 `meta`，且全会话没有任何来自 metaboard 插件的 `user/message`（评审行的唯一来源）。账本渲染出一行 `metaboard_review · failed · turn 1 / step 1` / `(此次调用没有信封)`。修复前这里什么都没有。 |

## 判据 6 的三条失败路径是怎么造出来的

`metaboard_revise` 的 `failForTest` 开关在 Task 4 的修复轮里按 Ruling R11 删掉了 ——
它是模型可达的伪造失败记录的入口。删掉之后，四个工具里没有任何一条模型或用户可以
从对话里触发的真实失败路径（`execute` 里的 `try` 块只有纯字符串运算，`catch` 是
不可达的预留）。两条路径分别这样验：

1. **缺信封的失败（模型可达，不需要改任何代码）**：让模型故意漏传 `metaboard_revise`
   的必填参数 `notes`。`defineTool` 的包装器在 `execute` 之前抛 `ToolArgsError`，
   结果事件没有 meta —— 这正是 Ruling R12 记录的那条框架固有缺口，本次是它第一次
   在真实会话 + 真实渲染下被观察到。

2. **评审工具的缺信封失败（模型可达，最终审查发现后补验）**：同样是让模型漏传必填参数，
   但换成 `metaboard_review` 的 `note`。它与第 1 条不是同一条路径 —— 评审的可见行来自
   `execute` 里 `deferContext` 写的 `user/message`，而 `ToolArgsError` 抛在 `execute` 之前，
   那条消息根本不存在。见下文 R20 一节。

3. **带信封的业务失败（需要制造）**：临时在 `lib/tools/revise.js` 的 `try` 块首行插入
   一句 `throw new Error('injected failure for acceptance criterion 6')`，重启 dsh 跑一次
   完整参数的 `metaboard_revise`，观察后立刻还原。选这个做法而不是重新加一个开关，
   是因为它跑的正是生产代码的 `catch` 分支 → 返回带 `error` 的值 → `presentationMeta`
   照常执行 → 信封落盘，链路一字未改；而它不进 schema，模型够不着，不违反 R11。
   验证结束后 `git checkout lib/tools/revise.js` 还原，`git status` 干净，`npm test`
   重跑全绿。**这段注入代码没有进任何 commit。**

**给后来者的提醒：不要去工具的参数表里找失败开关，那里没有。**
`metaboard_revise` 曾经有一个 `failForTest` 参数，Task 4 用它演示过失败路径，
Ruling R11 把它删掉了 —— 它随工具定义发给模型，任何人让 agent「测一下 revise」
都能往真实会话的持久化日志里注入一条与真实失败无法区分的伪造记录，而 Task 6 之后
读的正是这些记录。代价就是本节这套办法：带信封的失败只能靠临时注入一次异常来验，
不可重复执行；可重复的部分由单测覆盖（`status` 折叠的三种证据、失败行渲染）。

## R19：修复与复验

初次验收暴露的问题是 `callDefinition.update` 只把 `data.error` 当作传输失败的证据。
按 Ruling R19 改为三种证据任一成立即判 `failed`：`data.error` 存在、
`message.content[0].isError` 为真、`payload.error` 存在。R16 的语义没有变
（账本说的仍是「这步活干成没有」），变的是它读的证据面。

同时重写了那条把问题遮住的单测——重写后先验证它对修复前的代码变红、对修复后变绿：它此前构造的
事件把错误挂在 `data.error` 上 —— 系统在这条路径上从不产出这种形状，所以测试一直
是绿的，而真实会话里那一行是错的。

## R20：最终审查发现的第四道缝，与复验

初次验收把判据 6 记为「成立」，但证据只覆盖了 `metaboard_revise` 与 `metaboard_draft`
两个工具。最终整分支审查指出：四个工具里唯一没验到的 `metaboard_review`，恰好是失效的
那一个 —— 而且它的失效方式比僵尸行更彻底。

模型漏传 `metaboard_review` 的必填参数时：

1. `tool/call` 落盘，`callDefinition.start` 建行，并按 R18 打上 `referenceOnly` 标记；
2. `defineTool` 的包装器在 `execute` 之前抛 `ToolArgsError`，`deferContext` 从未执行 ——
   **没有 `user/message`，`reviewDefinition` 无行可产**；
3. `tool/result`（`isError: true`、无 meta）把调用行收尾成 `failed`；
4. 渲染层按 `referenceOnly` 把这唯一一行过滤掉。

净结果是一次失败的评审在账本上等于没发生过。不是停在 running 的僵尸行，是零行。

这是本项目第四次「两个各自正确的决定相撞」，也是第一次撞的是三个：评审的可见行来自
`user/message`（Task 5）、调用行照常产出只打抑制标记（Task 6 / R18）、渲染层按标记过滤
（Task 8）。三份任务级 diff 里任何一份单独看都没有问题，只有把「评审的可见行依赖
`execute` 跑成功」和「抑制条件与 `status` 无关」放在一起，缺陷才成立。

**Ruling R20：抑制条件必须同时要求这次调用成功。** 抑制仍然留在呈现层（R18 的理由不变），
只是判据从 `referenceOnly` 改成 `referenceOnly && status === 'done'`。代价是评审的调用行在
running 期间会短暂可见 —— 这是对的，一次在飞的评审本来就是真事，它在完成时消失。

回归测试钉两个方向：失败的评审调用行必须留下，成功的仍要被挡。只钉一个方向的话，一个
从不过滤的渲染层也能让测试通过。两条测试都先验证对修复前的代码变红。

## 结论

**装配器能承载非编码业务 —— 有条件。**

条件有三条，都是实测出来的，不是推断：

1. **业务身份必须自带，不能靠推断。** 装配器只保证「同一个 id 的事件收进同一个
   Context」，业务含义（这是 draft 还是 review、它引用了谁）全部由 `tool/result.meta`
   的信封携带。信封写不进去（工具抛异常、参数校验失败、子派发）的那些路径，
   装配出来的行就只剩传输层信息。这一阶段用「工具永不抛异常」把大部分路径堵上了，
   但堵不住 `execute` 之前的那一段。

2. **引用只能按调用 id 解析，且被引用的节点必须真的进得了索引。** R18 那次修复的
   教训：任何在数据层「为了不显示」而丢弃节点的做法，都会让引用结构性地无法解析。
   抑制必须留在呈现层（本任务按 `referenceOnly` 标记过滤）。

3. **status 的语义要在 Definition 里折叠好，而且要把宿主所有的失败落点都读全。**
   R16 把业务失败折进 `status`，下游渲染才默认是对的；这次验收发现折叠漏了宿主的
   另一个失败落点（`message.content[0].isError`），R19 补上。教训是：一个「成没成」
   的字段，值多少取决于它读了几处证据 —— 少读一处，账本就会在那一类失败上说谎，
   而且是安静地说谎。

除去这三条，本阶段没有为了跑通内容生产而改动装配器的任何行为，也没有向 Definition
里塞入任何编码语义 —— 但这句话的两个支撑句都需要说准，因为它们各自带着代价：

`match` 只读事件自己的形状与来源，不查历史、不解析业务内容。但它对 `tool/result`
**不看任何名字**：一律按 `toolCallId` 认领。这是 R12 的解法（`tool/result` 事件里根本
没有工具名），代价是 MetaBoard 认领会话里**每一个**工具结果，包括 dsh 自带的和别的
插件的 —— 见下面的「已知代价」。

`buildViewNode` 除了搬运信封字段，还多算一个 `referenceOnly` —— 那是 MetaBoard 自己的
呈现判断，R18 与 R20 两条裁决都是围着这一个字段转的。它不是编码语义（装配器不认识它，
只当作节点 data 原样带走），但它也不是纯搬运。

**「装配器是领域无关的」这句话，在这一阶段从读代码的推断变成了跑出来的事实 ——
代价是两条，都记在下面。**

## 已知代价

两条，都是 R12 那个解法的固有代价，不是疏忽，本阶段也没有干净的收窄办法：

1. **每一个外部工具的结果都会留下一个惰性 Context。** 因为 `match` 认领全部
   `tool/result`，装配器会为每一条建一个 Context。它不产出节点（`start` 从未跑过，
   `buildViewNode` 见 `state === undefined` 直接返回 null），也不会崩，数量受当前
   加载窗口约束。但事实需要说明白：装上 MetaBoard 之后，它在每个会话里对全部工具
   结果都有一次动作，不管用不用得上。

2. **会话内每个工具结果都会请求 `immediate` 发布。** spec 第 6.3 节选默认 immediate 时，
   理由是「MetaBoard 的调用无流式增量」—— 那个理由写在 `match` 只认领自家调用的前提下。
   R12 放宽之后前提没了，而且收不回来：`publication(match)` 只拿得到 match，
   `tool/result` 事件里没有工具名，无法在发布阶段区分自家结果和别人的结果。实际影响
   有限 —— dsh 自己的 chat / trajectory Definition 本来就认领 `tool/result`、本来就请求
   immediate，MetaBoard 的增量约等于零；且没有 upsert 时 `builder.apply` 根本不被调用。

## 这一阶段验的是什么，不是什么

四个工具都是桩。`metaboard_research` 返回三条硬编码素材，`metaboard_revise` 返回常量
`{added: 180, removed: 95}` 且从不读 `args.notes`，`metaboard_draft` 是
`outline.repeat(200)`。所以「四个工具全部被模型调用成功」说的是**装配路径**跑通了 ——
调用被认领、信封落盘、节点装配、引用解析、账本渲染 —— 不是内容生产的质量。
内容本身在这一阶段不构成任何证据。

## 意外发现

1. **参数校验失败的传输错误信号不在 `data.error` 上，而在
   `message.content[0].isError` 上 —— `callDefinition.update` 没有读它，于是失败的
   调用被渲染成绿色的 done 行。**

   实测事件（seq 2428，会话日志原文）：

   ```json
   {"type": "tool/result", "seq": 2428, "data": {"turn": 2, "step": 1,
     "message": {"content": [{"type": "tool-result",
       "toolCallId": "call_00_2GwiBHwcy49Igmb8tK044788",
       "content": [{"type": "text", "text": "Error: invalid arguments: missing required property \"notes\""}],
       "isError": true}]}}}
   ```

   `data.error` 不存在，`data.meta` 不存在。`callDefinition.update` 缺信封的分支写的是
   `next.status = d.error === undefined ? "done" : "failed"`，于是判成 done。

   这与 Ruling R16 的意图直接冲突 —— R16 说「status 该显示的是这步活干成没有」，
   而参数漏传显然是没干成。它也说明 Task 6 的单测
   「缺信封的 tool/result 仍然给这一行收尾」用的事件形状
   （`toolResult('d2', undefined, { name: 'ToolArgsError' })`，把错误放在 `data.error` 上）
   在真实系统里不存在：那条路径真实的信号是 `isError`。测试因此一直是绿的，
   而真实会话里是红的。

   **已按 Ruling R19 修复**（`hasTransportError` 同时读 `data.error` 与
   `message.content[0].isError`，与 `payload.error` 一起构成三种失败证据）。
   控制者核对框架源码确认了成因：`toolErrorResult` 只在 `result.error?.info` 存在时
   才写出 `info`（`dsh-tools/lib/index.js:3483` 的 `...info ? { info } : {}`），
   而 `ToolArgsError` 没有 `info`，所以这条路径的 `data.error` 根本不会被写出。
   那条建立在虚构形状上的单测已改用实测形状重写，并先验证它对修复前的代码变红、
   对修复后变绿。

2. **brief 里的槽位注册方式读不到后续更新。** brief 给的写法是在 `inject` 里
   `ctx.sessions.binding(sessionId).session`，再在渲染函数里 `session.getSnapshot()`。
   `getSnapshot()` 取的是一次性的值，没有订阅，追加的行不会触发重渲染。改用 dsh 自己
   `conversation.view` 条目的标准做法（`ui-trajectory` 同款）：组件从标准套件拿
   `useSession`，`props.useSession(s => s.views.get("metaboard"))`。现场证据是判据 6
   那一行 —— 它是在没有刷新页面的情况下自己出现在账本里的。

3. **人工评审行没有 turn / step —— 而且不是漏取，是事件里就没有。**
   我最初以为是 `reviewDefinition.start`（Task 6）只取了 `seq/at/summary/text`
   而漏掉了这两个字段，核对会话日志原文后更正：评审那条 `user/message`（seq 1747）
   的 `data` 只有 `content` / `source` / `role` / `id`，**没有 `turn`，也没有 `step`**
   ——`tool/call` 和 `tool/result` 有，`user/message` 没有。所以这不是取不取的问题，
   要让评审行显示 turn/step，只能从相邻事件或它自己那次 `metaboard_review` 调用行
   推断。判据 3 在工具调用行上完全成立，在评审行上缺这两层，如实记在这里。

4. **计划阶段的裁决 F3 被现场证实是必要的。** brief 的渲染统一读 `r.data.payload`，
   而评审行的 state 里根本没有 `payload`。按 F3 分支渲染（调用行读 `payload`、
   评审行读 `text`）之后，评审行显示的是评审原文；若按 brief 原文实现，五行里会有
   一行是空的。

5. **一次评审只出一行这件事，在真实会话里是靠呈现层的 `referenceOnly` 过滤实现的。**
   账本里 step 序号从 2 直接跳到 4（step 3 是 `metaboard_review` 的调用行，被过滤掉了），
   而 revise 对它的引用照常解析 —— 这是 R18 那次「把抑制从数据层挪到呈现层」的
   完整闭环在现场的样子。

## 附录：本记录引用的裁决

这份记录是本分支里唯一入库的散文件；开发期的台账、任务报告、spec、plan，以及正文
两处提到的 brief（派给各任务的实施说明，其中被推翻的写法在正文里已原样引出）都在
`.gitignore` 里。所以正文引用到的裁决，这里各留一份摘要，读者不必去找拿不到的东西。
每条的完整背景与代价论证在开发台账里，不入库。

- **R2'**：验收用系统安装的 `dsh`（0.1.0-rc.6），不用 `npx` —— 后者在这台机器上会卡在代理后面。
- **R5**：验收启动方式固定为 `NODE_USE_ENV_PROXY=1 dsh --profile metaboard-dev --port <port>`。
- **R11**：从 `metaboard_revise` 的公开参数表里移除 `failForTest` 测试开关。它随工具定义
  发给模型，任何人让 agent「测一下 revise」都能往真实会话的持久化日志里注入一条与真实
  失败无法区分的伪造记录 —— 而 Task 6 之后读的正是这些记录。代价是带信封的失败路径
  只能靠临时注入一次异常来验，不可重复执行；可重复的部分由白盒测试覆盖。
- **R12**：承认「工具永不抛异常」有一个工具层管不了的缺口。`defineTool` 的包装器在用户
  `execute` 之前先跑参数校验并抛 `ToolArgsError`（`dsh-tools/lib/index.js:862`），
  而 `toolErrorResult` 的返回结构里没有 `meta` 字段。抛出点在工具之上，工具拦不住。
  解法是让 `metaboard-call` 的 `match` 认领**全部** `tool/result`（id 取 `toolCallId`），
  由引擎按是否存在对应 Context 决定去留 —— 因为 `tool/result` 事件里根本没有工具名，
  没有更窄的判据可用。代价见上面的「已知代价」两条。
- **R16**：`status` 必须反映业务成败，不能只反映传输成败。四个工具刻意把失败吞进返回值
  以维持 never-throw，于是业务失败在事件层表现为「`tool/result` 没有 error，而
  `meta.payload.error` 有内容」。折叠进 `status` 之后，下游渲染默认就是对的。
  代价是失去区分传输失败与业务失败的能力 —— 需要时 `payload.error` 与 `isError` 都还在。
- **R18**：抑制评审调用行的时机，从 `buildViewNode`（数据层）移到渲染层。原先在数据层
  丢弃节点，导致该节点的 `callId` 永远进不了引用索引，而 `revise` 的 `derivedFrom` 里
  存的正是这个 callId —— 引用不是「尚未加载」，是结构上不可能解析。改为照常产出节点
  并打 `referenceOnly` 标记，索引照常收录，渲染层按标记跳过。打显式标记而不让渲染层
  重新按工具名推导，是为了让过滤条件可见。
- **R19**：判定失败时必须读 `message.content[0].isError`，不能只读 `data.error`。
  `toolErrorResult` 只在 `result.error?.info` 存在时才写出 `data.error`
  （`dsh-tools/lib/index.js:3483` 的 `...info ? { info } : {}`），而 `ToolArgsError`
  没有 `info`。三个信号取或：`data.error`、`message.content[0].isError`、`payload.error`。
- **R20**：抑制条件必须同时要求 `status === 'done'`。完整论证见上文 R20 一节。
- **F3**：账本按行类型分支渲染 —— 调用行读 `payload`，评审行读 `text`。计划阶段的裁决，
  现场证实必要：评审行的 state 里根本没有 `payload`，统一读 `payload` 会让五行里有一行是空的。
