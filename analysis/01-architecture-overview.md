# 架构总览

> 独立梳理导读；权威来源：[docs/architecture.md](../docs/architecture.md)、[docs/cordis-primer.md](../docs/cordis-primer.md)。修改 `packages/` 前请先读原文。

## 产品定位

DeepSeek Harness（`dsh`）是一个 agent harness：它驱动 LLM 与工具循环完成编码任务。其核心架构决策是 **一切皆插件**——模型适配器、工具注册表、会话日志、乃至 agent 循环本身都是插件，因此任何部分都可以从配置层替换。没有需要打补丁的特权内核：扩展 dsh 的方式是在其他插件旁边挂载自己的插件，注册随插件卸载而可逆地回退。

底座是 Cordis（源码内嵌于 `vendor/`，重命名为 `@deepseek-ai/cordis` 等），一个"插件贡献服务、类型化事件、可逆效应到共享上下文"的框架。

## 总体分层

```text
┌─ apps/          入口薄壳：apps/cli（dsh 命令）、apps/web（浏览器前端构建）
├─ bundle 组装层   dsh-base / dsh-web-app / dsh-headless 等 patch 层（packages/bundle/）
├─ packages/      能力插件层：~50 个包组、200+ 个 @deepseek-ai/dsh-* 插件包
│    core/ session、system-prompt、tools、agent、agent-loop、scope（产品 API 脊柱）
│    llm/ shell/ fs/ subprocess/ web/ subagent/ session/ ……（能力族，见能力接缝一节）
├─ vendor/        内嵌 Cordis 框架（cordis、loader、include、group、hmr 等 9 个包）
├─ python/        Python SDK + 打包运行时（stdin/stdout 上的 JSON-RPC 子进程驱动）
└─ native/        Landlock 原生加载器（@deepseek-ai/node-addon-landlock-run）
```

一次运行中的 `dsh` 是开机时从有序层组合出的**插件树**，而非编译期固定的程序。

## Cordis 内核模型

理解一切的前提是 Cordis 的五个概念（[primer](../docs/cordis-primer.md)）：

1. **插件是实现 Service 的对象**——带可选 `inject` 与 `apply(ctx)` 的函数，或 `Service` 子类，生命周期由 Cordis 挂载进上下文。
2. **上下文是服务仓库**——服务认领稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）；其他插件按键查找，而非导入具体实现。
3. **以 `inject` 声明依赖**——命名了所需服务的插件会等待服务就绪，加载顺序由服务需求表达，而非手工编排。
4. **类型化事件通信**——通过 TypeScript declaration merging 声明事件名，再按语义选择派发模式。
5. **注册即可逆效应**——prompt 分节、工具 schema、适配器、监听器都经 `ctx.effect()` / `ctx.on()` 安装，重载与卸载可预期回退。

派发模式是事件公共契约的一部分（新事件以 `@mode` 标注，生成目录据此校验）：

| 模式 | 是否等待 | 派发顺序 | 有返回值 |
|---|---|---|---|
| `emit` | 否 | 注册序观察 | 否 |
| `waterfall` | 否 | 注册序环绕 | 是 |
| `parallel` | 是 | 并行 | 否 |
| `serial` | 是 | 注册序 | 是 |

**waterfall 即环绕中间件**：监听器收到 `(...args, next)`，调用 `next()` 把（可能改写过的）结果交给下一个服务；不调 `next()` 即短路。单决策事件（如 `agent/pre-step` 的拒绝）以短路为设计意图，只注解或观察的监听器必须委托。

## 组合层：Profile 与 Bundle

- **profile** 是存于 Harness home（`$DSH_HOME`，默认 `~/.dsh`）`profiles/<name>/` 下的命名组合：`package.json` 里的 `dsh.profile` 声明有序 bundle 列表和树外插件依赖，目录内可放用户自己的 `cordis.patch.yml`。`web` 与 `headless` 是内置模板。
- **bundle** 是 Cordis 配置行及其挂载代码的发行格式（`package.json` 的 `dsh.bundle` 指向 patch 文件），它插入的任何行仍可被上层 patch。

层叠顺序（对空 entry 列表依序应用）：profile 列出的各 bundle → profile 的 `cordis.patch.yml` → home 级 `cordis.patch.yml` → `--patch` 命令行覆盖。patch 按 id 整体替换目标行配置，或插入新行。`dsh --profile <name> --dump-config` 可离线渲染实际启动的插件树。细节见 [启动与组合流程](04-boot-and-composition.md)。

## 核心 spine 包

| 包 | 职责 | `ctx` key |
|---|---|---|
| `core/session` | 追加式 `SessionEvent` 日志与内存存储 | `ctx.sessions` |
| `core/system-prompt` | prompt 分节与工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 按 scope 过滤的工具注册表 + 带防护的执行管线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、存活注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现该接口的默认驱动器 | `ctx.agentLoop` |
| `core/scope` | 每 agent 的 scope 注册原语 | 库，无 key |
| `llm/llm` | 消息/流词汇表 + 适配器接缝 | `ctx.llm` |

## 事件体系：三个域

事件是主要扩展点，选对域是大多数改动的第一个决策：

- **会话事件**（`SessionEvent`）：追加入日志、经 `session/event` 广播的持久事实。事实需要在重载后存活时用它。
- **Agent 事件**（`agent/*`）：携带存活 `Agent` 的实时控制/状态——inbox、step、status、request、验证、续跑。观察或拦截进行中的工作用它。
- **能力事件**：把策略与适配器挂到接缝上（`fs/*`、`tools/*`、`telemetry/*`），无需导入循环本身。

每个事件的生产者/消费者清单见 [docs/event-producer-consumer.md](../docs/event-producer-consumer.md)。

## 循环与会话日志（概览）

- **step** = 一次模型请求 + 它引发的工具执行；**turn** = 零或多个 step：在认领第一段输入前开启，不再亏欠任何东西时关闭。
- 会话日志是模型所见上下文的唯一来源：`deriveMessages()` 从日志投影模型历史；fork、resume、转录、遥测、持久化全部派生自这条流。
- **模型可见 ⟺ 已记录**：任何到达模型请求的内容必须能从日志重建（有运行时不变量断言）。因此新增模型可见输入必须新增会话事件。

完整时序见 [Agent 循环与会话流程](05-agent-loop-and-session.md)。

## 能力接缝

**接缝** = 可替换能力，含三个角色：**Service Definition**（声明接口、拥有 `ctx.<key>` 与词汇类型）、**Service Provider**（实现）、**Consumer**（使用，常见为模型可见工具）。一个包可兼多角色，但只有一个角色不构成接缝；新增能力意味着三角色齐备。接缝是"换一个 provider 即改变整个产品"的原因：fs 与 subprocess provider 共享一个执行世界，把它们指向远程沙箱即可连 Bash、PTY、LSP 一起搬走，无需 provider 分叉。全景与代表案例见 [工具执行管线与能力接缝](06-tool-pipeline-and-capability-seams.md)。

## Host / Client 双面架构

Web 形态是两个 TypeScript 聚合程序（同一仓库、互不混编，因为两侧以同名 key declaration-merge 出不同的 `Context`）：

- **Host（Node 进程）**：`packages/host/webserver` 提供纯 `node:http` 载体与命名路由；`apiproxy`（`ctx.apiProxy`）是传输无关的网关面；`packages/api/gateway` 实现 Typert RPC 网关——业务服务以 `@Remote` / `@RemoteScope` 标注方法，Host 构建期由 Typert 生成 Host-for-Client 类型与运行时贡献，调用复用 Connection RPC 与 `/api` 路由（详见 [docs/api-gateway.md](../docs/api-gateway.md)）。
- **Client（浏览器）**：React 18 壳（`packages/client/web`、`web-react`）+ 三十余个 `ui-*` 插件渲染会话、工具卡片、设置等；`connection` 承载 RPC，`modules` 组合客户端插件图，`remote` 命名空间消费生成的远端方法。
- `apps/web` 只是用 Vite 构建 client 壳库的入口，产物由 `apps/cli` 的 `dsh web` 托管（默认 `http://127.0.0.1:3080`）。

## 横切工程不变量

以下约定贯穿全部包（完整列表见根 [AGENTS.md](../AGENTS.md)）：

- **注册即效应**：一切贡献经 `ctx.effect()` / `ctx.on()`，`register()` 返回清理器。
- **waterfall 监听器必须调 `next()`** 委托；返回即短路整链。
- **判别式标签 switch**：封闭联合以 `assertNever` 收尾；可扩展联合走过有文档的 default。
- **跨边界不透明 id 一律品牌化**（`Branded<B>`），不用裸 `string`。
- **类型化同进程边界信任 TypeScript**：不为静态接口已保证的值加运行时校验；在解析器/配置、排队、模型与工具 JSON、持久化、worker、进程、线上协议边界才校验。
- **显式优于隐式（包边界）**：缺省化是 owning 实现里显式的 `resolve(request): Spec` 步骤，不是 `run()` 里的隐藏 `?? default`。
- **插件优先于改循环**：新行为落在有文档的扩展点上；改 `agent-loop` 必须更新 docs/architecture.md。
- **误配置要响亮失败**：自包含的在加载期失败，否则在最早可解析点失败；绝不静默跳过缺失引用。
- **源码面与构建面不混**：静态门禁经 tsconfig `paths` 解析到 `src`，干净树上通过；消费 `lib/` 的门显式声明该依赖。
- ESM 全仓（`"type": "module"`）；`strict: true` + `noImplicitAny`。

## 仓库目录地图

| 目录 | 内容 |
|---|---|
| `vendor/` | 内嵌 Cordis 框架（9 包，重 scope 为 `@deepseek-ai/*`，manifest 记录上游 SHA） |
| `packages/<group>/<pkg>/` | ~50 个包组的插件包；组级 README 持有包/ctx-key 映射 |
| `apps/cli` | `dsh` 命令（profile 启动、插件管理、浏览器 UI 别名） |
| `apps/web` | 浏览器前端的 Vite 构建入口 |
| `examples/` | 可运行的 cordis.yml 叶子（demo bundle） |
| `python/` | Python SDK（`deepseek-harness-sdk`）与打包运行时（`deepseek-harness-runtime-bin`） |
| `native/` | Landlock 原生 addon 源码 |
| `docs/` | 权威文档（架构、子系统、生成目录、cookbook、postmortem） |
| `.agents/` | Agent 工作流、技能与 Agent Notes（决策记录） |
| `scripts/` | 仓库门禁与生成器（run-gates.ts 聚合） |
| `website/` | VitePress 文档站（双语投影） |
