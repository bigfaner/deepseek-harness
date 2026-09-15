# DeepSeek Harness 项目梳理（导读索引)

本目录是一套独立的中文梳理文档，面向需要快速建立全局认识的读者（新 contributors、评审者、接入方）。它是对仓库权威文档的提炼与重组，不是权威语料本身；两者冲突时以 `docs/` 下的原文为准。

- 权威架构文档：[docs/architecture.md](../docs/architecture.md)（[中文](../docs/architecture.zh.md)）
- 权威术语表：[docs/glossary.md](../docs/glossary.md)（[中文](../docs/glossary.zh.md)）
- Cordis 入门：[docs/cordis-primer.md](../docs/cordis-primer.md)
- 各子系统参考：[docs/subsystems/](../docs/subsystems/README.md)

## 文档清单与阅读路线

| 顺序 | 文档 | 内容 | 对应权威来源 |
|---|---|---|---|
| 1 | [01-architecture-overview.md](01-architecture-overview.md) | 架构总览：分层、Cordis 内核、组合机制、核心包、事件体系、横切不变量 | docs/architecture.md、docs/cordis-primer.md |
| 2 | [02-glossary.md](02-glossary.md) | 关键术语表：按域分组的中文释义，保留英文原词 | docs/glossary.md、docs/cordis-primer.md |
| 3 | [03-tech-stack.md](03-tech-stack.md) | 技术栈：语言运行时、构建、测试、质量门、原生组件、外部集成 | docs/development.md、docs/testing.md、根 package.json |
| 4 | [04-boot-and-composition.md](04-boot-and-composition.md) | 核心流程一：启动与组合——profile/bundle/patch 层叠与环境解析 | packages/boot/app-boot/README.md、docs/architecture.md |
| 5 | [05-agent-loop-and-session.md](05-agent-loop-and-session.md) | 核心流程二：Agent 循环与会话——turn/step 生命周期、会话日志、持久化与恢复 | docs/agent-lifecycle.md、docs/architecture.md |
| 6 | [06-tool-pipeline-and-capability-seams.md](06-tool-pipeline-and-capability-seams.md) | 核心流程三：工具执行管线、审批与沙箱、能力接缝全景与代表案例 | docs/tool-execution-pipeline.md、docs/capability-seams.md |
| 7 | [07-plugin-mechanism.md](07-plugin-mechanism.md) | 插件机制：Cordis 原理（内核构件/服务/事件）、fiber 生命周期状态机、插件开发指南 | vendor/cordis 源码、docs/cordis-primer.md、docs/cordis-tutorial/、docs/cordis-api/ |
| 8 | [08-core-packages.md](08-core-packages.md) | core 子包深入：8 个子包的依赖分层、scope 机制、会话投影、工具管线、agent 契约与默认循环（含 mermaid 关系图/流程图/时序图） | packages/core/* 各包源码与 README、docs/subsystems/ |
| 9 | [cordis-source/](cordis-source/README.md) | Cordis 内核源码分册精读（子目录 10 篇）：README 导读 + 9 个 TS 文件逐册精读（utils/context/reflect/events/registry/fiber 上下册/service/logger），每册配 mermaid 图与 TypeScript 进阶知识点，附术语表与 TS 知识索引 | vendor/cordis/src |
| 10 | [10-core-code-walkthrough/](10-core-code-walkthrough/README.md) | core 子包代码精读（Java 视角，子目录 8 篇）：TS 语法速成对照、scope/session/system-prompt/tools/agent/agent-loop 逐包精读、不变量与 llm 词汇、五条工程格言 | packages/core/* 源码 |

建议按序号阅读：先建立架构与词汇（1、2），再了解工具链（3），最后按三条主线理解运行时行为（4→5→6）；需要深入插件层（开发扩展、读懂生命周期）时阅读 7，需要包级结构细节（core 各子包如何互相依赖、内部机制）时阅读 8，直接读 Cordis 内核源码时对照 9，逐行读 core 各包源码（含 TS→Java 语法对照）时对照 10。

## 一句话定位

DeepSeek Harness（`dsh`）是 DeepSeek AI 开发的开源 agent harness：一个把"模型适配、工具注册、会话日志、agent 循环"全部做成可替换插件的编码代理运行时，基于源码内嵌（vendored）的 Cordis 插件框架组装而成。
