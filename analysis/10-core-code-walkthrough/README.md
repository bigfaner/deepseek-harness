# core 子包代码精读(TypeScript → Java 对照)

> 面向 Java 背景读者的逐包源码讲解(由原单篇文档拆分为本子目录)。每个构造都给 Java 对照,所有结论落在 `file:line`。
> 前置阅读:[../08-core-packages.md](../08-core-packages.md)(包关系图与流程图)、[../cordis-source/README.md](../cordis-source/README.md)(Cordis 内核精读)。

## 文档清单与阅读顺序

| 顺序 | 文档 | 内容 | 对应源码 |
|---|---|---|---|
| 1 | [01-ts-for-java.md](01-ts-for-java.md) | TS 高级语法速成:三个心智模型、类型系统 24 项 + 运行时 15 项对照表、Cordis↔Spring 对照 | — |
| 2 | [02-scope.md](02-scope.md) | 作用域原语:ScopeKey、scopeTarget 事件过滤、ScopedLayers 分层存储 | `packages/core/scope` |
| 3 | [03-session.md](03-session.md) | 事件溯源日志:SessionEvent 信封、append 六条纪律、表面投影、崩溃恢复、store 三段式 | `packages/core/session` |
| 4 | [04-system-prompt.md](04-system-prompt.md) | 请求前缀组装:PromptLayer、assemble 九步、严格插值 | `packages/core/system-prompt` |
| 5 | [05-tools.md](05-tools.md) | 工具注册表与执行管线:ToolDefinition、view 可见性、五阶段管线、defineTool 类型魔法 | `packages/core/tools` |
| 6 | [06-agent.md](06-agent.md) | Agent 公共契约:接口、Inbox、融合派发、注册表与 initiator;附 agent-default-model 与 agent-tool-presentation 两个小包 | `packages/core/agent` 等 |
| 7 | [07-agent-loop.md](07-agent-loop.md) | 默认驱动器:工厂与事务性 prepare、三态状态机、turn/step 逐段、工具调度器 | `packages/core/agent-loop` |
| 8 | [08-invariants-and-llm.md](08-invariants-and-llm.md) | 不变量伴随件机制、dsh-llm 必读词汇、贯穿 core 的五条工程格言 | `packages/runtime-diagnostics/invariants`、`packages/llm/llm` |

建议:**先读 01 建立语法心智模型**(否则后续代码里的类型级写法会看不懂),再按依赖分层 02→08 顺序读;时间有限时优先 05(tools)与 07(agent-loop)——这两篇是运行时行为的枢纽。
