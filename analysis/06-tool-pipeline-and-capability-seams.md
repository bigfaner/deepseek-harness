# 核心流程三：工具执行管线与能力接缝

> 独立梳理导读；权威来源：[docs/tool-execution-pipeline.md](../docs/tool-execution-pipeline.md)（管线图）、[docs/capability-seams.md](../docs/capability-seams.md)（服务全景表）。本文先走完一次工具调用的完整管线，再给出接缝全景与代表案例。

## 工具执行管线

模型响应中的工具调用块先落盘 `tool/call` 会话事件（执行前），UI 同时渲染 pending 卡片（`presentCall(args)`）。随后进入五段式管线：

```text
tools/pre-execute (w)     钩子、权限、沙箱策略
   ├─ deny ──────────────→ 跳过工具体（denied）
   ├─ ask ──→ ctx.approval 一次性审批
   │             ├─ allowed-once → 进入守卫
   │             └─ 拒绝/取消/不可用 → denied（失败关闭）
   └─ allow →
注册的单调守卫          deny 或弃权；身份受保护
tools/execute (w)        超时、重试、指标（环绕派发）
工具 execute() 体        真正执行
   ├─ tool-fs 的变更走 fs/write-intent、fs/edit-intent 事件门
   └─ 工具自有的会话事件：todo/write、fs/observed、hook/invoked、hook/result、tool/code-dispatch
tools/post-execute (w)   接受 / 拦截 / 替换 / 附加上下文
注册表外层归一化         result 快照抛错 → isError
ToolDefinition.finalizeContent   最后的内容不变量（同步、仅内容）
tools/result             同步通知；冻结的权威结果
——> tool/result 会话事件（单一模型可见结果）→ UI presentResult
活动批次 additionalContexts FIFO → 在已记录工具结果之后注入 user/message
```

关键性质：

- **三个 waterfall 都可改写调用**；策略（钩子、审批）挂在通用 pre/post 上，不耦合具体工具。around 类关切（超时）包裹 `tools/execute`。
- **失败关闭**：审批缺失或无法应答即拒绝；守卫拒绝与 pre 拒殊途同归（跳过工具体直接到 post）。
- **结果归一化**：注册表无损快照候选结果、把快照失败归一化为 isError，再让可见定义的 `finalizeContent` 施加同步内容不变量；`tools/result` 观察的是不可变、无损 JSON 的结果。
- **additionalContexts**：工具可为活动批次追加上下文，按 FIFO 在工具结果之后以 `user/message` 注入——因为"模型可见 ⟺ 已记录"。
- **Code Mode**：保留的 `run_code` 传输与其序列化子调用都走同一管线；子调用携带父 token、记录 `tool/code-dispatch`、拒绝为绑定式、省略 `additionalContexts` 以保持调用/结果相邻。
- **溢出**：`spill-policy` 在 post-execute 决定超大工具文本落盘（返回定位符 + 取回提示）。
- 工具的 UI 渲染意图（generic / terminal / diff / locations）是设计的一部分，presentation 方法是 `args` 的纯函数。

## 审批与沙箱

- **审批**（`ctx.approval`）：一次性许可决策经 `approval/request` 瀑布派发；应答者是监听器（ACP 桥为自己的 agent 应答）。工具层（`ctx.tools`）与 `tool-bash` 都消费它。
- **权限预设**（`ctx.permissionPresets`）：用户面预设（`workspace-write` / `danger-full-access`）捆绑沙箱模式与审批策略；一次切换写一条 `permission/preset` 事件贯穿两个旋钮事件。
- **沙箱**（`ctx.sandbox`）：进程约束接缝。消费者交出**即将 spawn 的精确 argv**，后端（bwrap / Landlock / Seatbelt 的 `sandbox-local`）按每调用策略包装并报告执行情况。同世界的 bash 与 fs provider 读同一 `ctx.sandboxPolicy`（部署缺省模式 + 工作区根），保证两者不会圈禁到不同根。

## 能力接缝全景

50 余个 `ctx` 服务分为三类（完整表见 [docs/capability-seams.md](../docs/capability-seams.md)）：**core**（脊柱服务，如 `ctx.sessions`、`ctx.systemPrompt`、`ctx.tools`）、**seam**（三角色接缝）、**bundle**（`ctx.agentLoop` 这一个具体循环插件）。

代表性接缝（定义 → 实现 → 消费）：

| 接缝 | Service Definition | Service Providers | 代表 Consumer |
|---|---|---|---|
| LLM | `llm`（`ctx.llm`） | `llm-deepseek`、`llm-pi-ai`、`llm-replay`（测试） | `agent-loop`、`compaction-basic` |
| Shell | `shell`（`ctx.shell`） | `bash-local`、`bash-sandbox`、`pwsh-local` | `tool-bash`、`tool-pwsh`、hooks 桥 |
| 子进程 | `subprocess`（`ctx.subprocess`） | `subprocess-local`、`subprocess-e2b` | bash 执行器、`terminal-bash`、`lsp-stdio`、ACP/Codex/Claude Code 子代理后端 |
| 文件系统 | `fs`（`ctx.fs`） | `fs-local`、`fs-sandbox`、`fs-e2b` | `tool-fs`（+ `fs-observation-policy` 伴随插件经 `fs/*` 事件门） |
| 子代理 | `subagent`（`ctx.subagents`） | spawn/fork-in-process、acp、codex、claude-code、dsh-sdk | `tool-subagent`、`tool-subagent-control`、`tool-ralph` |
| Web | `web`（`ctx.web`） | search-exa / perplexity / deepseek、fetch-http | `tool-web`（拥有稳定的模型可见名） |
| 会话持久化 | `session-persistence` | jsonl、sqlite | `agent-loop`、hooks 桥、session-query |
| 设置 / 凭据 | `settings` / `credentials` | `settings-file` / `credentials-local` | LLM 适配器、apiproxy |
| 技能 | `skill`（`ctx.skills`） | `skill-filesystem`、`skill-badge` | `tool-skill`（目录渲染 + 全文加载） |
| 工作流 | `workflowEngine` | `workflow-worker-thread` | `tool-workflow`、`tool-ralph` |
| 终端 | `terminals` | `terminal-bash`（PTY） | `tool-terminal`（owner-scoped） |
| LSP | `lsp` | `lsp-local` | `tool-lsp`（恰好四种归一化操作，无协议逃生口） |
| 压缩 | `compaction` | `compaction-basic` | 无模型可见 compact 工具；经 pre-step/request-error 工作 |
| 代码执行 | `codeRuntime` | `code-runtime-worker` | `ctx.tools`（Code Mode） |
| 后台任务 | `jobs` | `jobs-local` | `tool-jobs` 及各生产者工具 |
| 溢出 | `spillStore` | `spill-local` | `spill-policy` |

接缝的杠杆效应：filesystem 与 subprocess provider 共享一个执行世界，指向远程沙箱（如 E2B）即把 Bash、PTY、LSP 一起搬走；subagent provider 从进程内子代理到对另一个产品的委托轮换，接口不变。

## 子代理与 Ralph

- `ctx.subagents` 既拥有 provider 传输，也拥有可选的 Activation 续跑编排。`tool-subagent` 选择一次性或可续跑委托；`tool-subagent-control` 投递追问；`tool-ralph` 要求一条全新的结构化输出路线。
- **Ralph loop** 是面向不可变目标的前台全新 agent 工作流：由 workflow + subagent 原语组成的模型可见工具策略。每个 **Ralph round** 是一个不带种子全新子会话；跨轮状态靠共享工作区与有界 **Ralph handoff**（状态/摘要/证据/后续/阻塞的结构化报告）。

## 钩子桥与自省

- `packages/hooks`：Claude Code / Codex 钩子桥 + 共享 wire-protocol 库，消费 `ctx.shell` 与持久化接缝。
- `packages/extensions`：agent 检视/改装自身运行时——`cordis-host-runner`（vm 沙箱内的宿主半 + 定义注册表）与 `tool-cordis`、`cordisInspect`；浏览器页面经 remote 命名空间到达同一服务。`pnpm run demo:cordis` 演示 agent 修改自己的插件运行时。

## 新行为落在哪（速查）

| 目标 | 机制 |
|---|---|
| 加模型 provider | 在 `ctx.llm` 上注册适配器 |
| 加模型可见能力 | 在 `ctx.tools` 注册；schema 自动进 prompt 组装 |
| 加 shell / 终端 / FS 执行世界 | 注册 `ctx.shell` / `ctx.terminals` / `ctx.fs` 后端 |
| 约束 spawn 进程 | 用 `ctx.sandbox` 后端；消费者在 spawn 前包装 argv |
| 拦截请求 / 工具 / turn | 用对应 `agent/*` 或 `tools/*` 事件 |
| 注入模型可见上下文 | `agent.inject()`；落在下一次被接纳的请求 |
| 加人类命令 | 注册 `ctx.commands`；不经模型 turn 直接派发 |
| 加后台工作 | 注册 `ctx.jobs`；`job_*` 工具收集/终止 |
| 加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染与重放 |

完整的"目标 → 能力"映射与分步指南见 [docs/cookbook/extension-cookbook.md](../docs/cookbook/extension-cookbook.md)。
