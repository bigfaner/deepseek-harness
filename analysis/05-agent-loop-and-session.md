# 核心流程二：Agent 循环与会话

> 独立梳理导读；权威来源：[docs/architecture.md](../docs/architecture.md) 的 Turn flow 与 Session log、[docs/agent-lifecycle.md](../docs/agent-lifecycle.md)（时序图）。本文梳理一次对话在运行时的完整生命周期：输入入箱 → turn/step 循环 → 会话日志落盘 → 恢复与派生。

## 输入如何到达驱动器

输入只有一个通道：**inbox**。`Agent.followup(content)` 等入口把消息插入 inbox（广播 `agent/inbox/inserted` / `agent/inbox/spliced`）；排队的工作唤醒驱动器（`agent/status` → running）。有些消息立即唤醒，注入的上下文（`agent.inject()`）则留在 inbox 等待下一条消息才被认领——这保证注入内容进入下一次被接纳的请求。

## turn 与 step

- **turn**：在第一段输入被认领前开启（`turn/start`），循环不再亏欠任何东西时关闭（`turn/end`）。含零或多个 step。
- **step**：一次模型请求 + 它引发的工具执行。

一个 step 的内部顺序（`——>` 为持久会话事件，`(w)` 为 waterfall）：

```text
claim：认领挂起的 next-step 输入 + 一条排队消息（每条广播 agent/inbox/claimed）
agent/pre-step (w)：拒绝 | enter(messages)
  ├─ 拒绝 / 首次 enter 被改写为空 → 无 step 地关闭 turn（日志仍记录这次尝试）
  └─ enter → step/start ——> 进入的每条消息落 user/message
       system-prompt/assemble (w)：收集 prompt 分节 + 工具 schema
       agent/request (w) → llm/stream (w) ——> assistant/chunk* ——> assistant/message
       工具批次：按 executionMode 分类；屏障 + 有界滚动池调度
         每个调用 ——> tool/call（执行前落盘）→ 工具管线（见流程三）——> tool/result
       ——> step/end
  若工具欠一次请求 / 新 next-step 输入到达 → 认领 → 下一个 step
agent/turn-stopping（serial，终局检查点，无 next()）
——> turn/end，agent/status → idle
```

要点：

- `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是**持久会话事件**；其余是跨三域的**实时扩展点**。`agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 waterfall（必须 `next()` 委托）；`agent/turn-stopping` 是 serial 且无 `next()`。
- `agent/pre-step` 决定模型看到什么：监听器可改写认领消息或直接拒绝；其返回决策是权威的。
- `assistant/message` 记录每次成功的 provider 调用（含无内容与 `max-tokens` 结束），带用量与 `sourceEventSeqs`（精确列出对应的 `assistant/chunk`，可为显式空表）；空内容不进派生历史。
- 消费回放数据用 `session/event`；`agent/*` 是队列/状态/拦截/续跑/错误的实时协调 API。

## 请求失败与恢复

- 最终适配器或带内终局请求失败：`step/end` 关闭当前步，`agent/request-error` (w) 给监听器返回重试动作或保留原错误的机会。
- `compaction-basic` 用 `agent/pre-step` 在请求派生前感知压力、用 `agent/request-error` 只处理经典的上下文溢出：触发后可选**工具结果剪枝**（可重放的单节点表面替换）先于**摘要选择**。恢复发生在已关闭的失败步与失败 turn 关闭之间；只有剪枝或摘要确实推进了表面替换代数，才开一个全新重试 turn，否则原请求错误保持权威。

## 会话日志：唯一事实源

- 追加式 `SessionEvent` 流，经 `session/event` 广播；内存 store 是 `ctx.sessions`。
- `deriveMessages()` 从日志**投影**模型历史；原始 `assistant/chunk` 保留用于重放与 UI 保真。
- **模型可见 ⟺ 已记录**：运行时不变量断言任何到达模型请求的内容可从日志重建。新增模型可见输入 = 扩展 `SessionEventMap` 并从日志渲染。`SessionEventMap` 成员默认读取时必需；未知事件类型且无 `ignorable: true` 信封的构建拒绝该日志。
- 事件 JSDoc 需 `@mode` 与载荷 `@param`；scoped 键缺席载荷需 `@dshScopeScan unsupported`。

## 持久化与派生

- **持久化接缝**：`ctx.sessionPersistence` 的 JSONL / SQLite 后端持久化同一 `SessionEvent` 词汇；应用在组装期选定后端。SQLite 用单调 `SCHEMA_VERSION`；JSONL 在 Windows 以 `MoveFileExW` 写透发布。
- **投影**：`ctx.sessionProjections` 注册按状态折叠的单元（todo、标题）；`session-projection-cache` 按会话持久检查点投影状态（节流 + `turn/end`/detach 强制点），冷读走"缓存行 + 持久化尾部重放"梯——列表永不加载全量日志。
- **fork**：`ctx.sessions.fork(source, boundary?, childSessionId?)` 从源会话（可指定边界）派生子会话。
- **resume / 续跑**：goal 激活刻意不进持久重放；resume/fork 后自动工作需经 `/goal` 或模型工具再次人类授权。
- **标题**：`ctx.sessionTitle` 拥有确定性回退与最新标题折叠，唯一可选异步 provider（首条 prompt / 全部 prompts 的 LLM 生成器）。
- **遥测**：`ctx.sessionTelemetry` 捕获、脱敏并递交会话记录给后端（OTel）。

## scope：每个 agent 自己的世界

- 注册两级扁平：全局（所有 agent 可见）或 scoped（恰属一个 scope key；存活 agent 是自身 scope 的 key）。
- `CreateAgentOptions.setup` 是**设置窗口**：scope 与 agent 对象已建、尚未发布、首 prompt 未组装；setup 只注册（人设、工具变体、restriction），从不驱动 agent。
- **shadowing**（最具体者胜）：scoped 工具/分节/变量在该 scope 内替换同名全局件；`tools.restrict` 为一个 scope 过滤全局工具集（交集复合），被滤掉的工具在 prompt 与执行中都等同于不存在。
- 父子事实走 **lineage 数据**（`parentSession`、`delegationDepth`、`subagentDepth`），不影响可见性；子代理不自动继承 scope。
- 每 preset 会话组合：`ctx.agentPresets` 在创建期把 preset `cordis.yml` 挂到 agent scope 下（服务行需 `isolate` realm），拒绝永不激活或泄入根服务域的行。

## 相关的持续工作形态

- **goal**（同会话目标）：`ctx.goals` 从日志折叠版本化目标状态；goal round 物化为一个 goal 来源的 turn，无关人类 turn 不消耗上限。
- **jobs**：后台工作注册进 `ctx.jobs`（后台 bash、PTY 发送、子代理委托）；`job_*` 工具读取/列出/终止。
- **Ralph**：全新子会话的前台工作流（见[流程三](06-tool-pipeline-and-capability-seams.md)的子代理一节）。
