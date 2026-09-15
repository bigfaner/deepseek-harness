# 技术栈

> 独立梳理导读；权威来源：[docs/development.md](../docs/development.md)、[docs/testing.md](../docs/testing.md)、根 `package.json` 与 `scripts/run-gates.ts`（脚本与门禁的唯一清单）。

## 语言与运行时

| 项 | 选择 | 要点 |
|---|---|---|
| 主语言 | TypeScript（`strict: true` + `noImplicitAny`） | 残存 `any` 必须解释为何无法收窄；模块与导出有 JSDoc 契约（`verify-export-jsdoc` 门禁） |
| 模块体系 | 纯 ESM（全仓 `"type": "module"`） | 包间用包名、本地相对导入用 `.ts`；`dsh` 源码启动走 tsx 的 ESM-only hook（`node --import tsx/esm`），其可达模块必须保持 ESM |
| Node 版本 | `^22.19.0 \|\| >=24.0.0` | CI 覆盖 22.19 / 24 / 26 |
| Python | Python SDK + 打包运行时（`python/`） | `deepseek-harness-sdk`（高级 turns API + 底层 JSON-RPC 客户端）与 `deepseek-harness-runtime-bin`（捆绑运行时二进制）；pytest |
| 包管理 | pnpm 11.7.0（Corepack 启用） | workspaces：`vendor/*`、`packages/*/*`、`native/landlock-run*`、`apps/*`、`website`、`examples`、`python/sdk-runtime`；`linkWorkspacePackages` 使 vendored 包的 semver 范围解析到 pinned 工作区；`allowBuilds` 默认拒绝带安装脚本的依赖（仅放行 esbuild、lefthook、node-pty、koffi 等）；`node-pty@1.1.0` 带 patch |

## 框架层：内嵌 Cordis

`vendor/` 源码内嵌 Cordis 框架（可审计、可打补丁、pinned），9 个包全部重 scope 为 `@deepseek-ai/*`：`cordis`、`cordis-plugin-loader`、`-include`、`-group`、`-timer`、`-hmr`、`-logger-console`、`cosmokit`、`schemastery`。每个 harness 包把 `cordis` 声明为 peerDependency，发布 harness 即随发框架层；manifest 记录上游 SHA，修改须经 vendor 同步流程（`verify-vendored-links` 断言无注册表副本）。

## 构建体系

- **双聚合程序**：`tsconfig.host.json`（Host/Node 侧）与 `tsconfig.client.json`（浏览器侧）两个聚合，因两侧以同名 key 合并出不同的 `Context` 接口，混入一个 `ts.Program` 会碰撞；根 `tsconfig.json` 只是引用两者的 solution。每个包恰好注册进一个聚合（唯一例外 `api/remotes` 双面拆分）。
- **构建顺序**：`tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host` → `tsc -b tsconfig.client.json` → `tsdown --env.DSH_BUILD_FACE client` → Web 构建。tsdown 只消费 tsc 先行产出的 `lib/types` JS；`DSH_BUILD_FACE` 环境变量让包内配置按相位选 entry。
- **Typert** 只在 Host tsdown 相位运行：分析 Host 类型，生成 Host 反射产物与 Host-for-Client Remote 投影；`typecheck` 因此先跑完整 Host lib 相位。
- **打包器**：tsdown（运行时 bundle）；前端用 Vite 6（`apps/web`）。
- **源码运行**：`pnpm dsh` 经 tsx ESM hook 直接跑 TypeScript 源；配置子进程则跑构建后的 `lib/`（普通 Node）。

## 前端

- React 18 + react-dom；Vite 构建；Playwright 用于浏览器测试/压测。
- 客户端本体是插件化的：`packages/client/` 下 30+ 个 `ui-*` 插件（会话、工具卡片、设置、sidebar、主题、schema-form 等）+ `connection`（RPC 载体）+ `modules`（客户端插件图）+ `hmr`。
- Host 侧经 `@Remote` / `@RemoteScope` + Typert 网关（`ctx.typertGateway`）向 Client 暴露一元 RPC；复用 Connection 与 `/api` 路由。

## 持久化与存储

| 机制 | 实现 |
|---|---|
| 会话持久化 | `session-persistence-jsonl` 与 `session-persistence-sqlite` 两个 provider；SQLite 用单调 `SCHEMA_VERSION`，后端拒绝旧盘上格式；JSONL 在 Windows 以 koffi `MoveFileExW` 写透发布 |
| 会话检索 | `session-query` 逻辑语料 + `session-query-sqlite` 全文检索（FTS、排序、片段、游世代） |
| 非会话存储 | `storage` hub + JSON/SQLite 后端 + `storage-domain` 类型化域形态 |
| 附件 | `attachment-local` 内容寻址二进制存储；Host 先提交图像再入会话事件，provider 适配器解析授权引用 |
| 凭据 | `credentials-local`：env 覆盖 `.env` 的引用式凭据；值不进配置 |

## 原生组件

- `native/landlock-run`（`@deepseek-ai/node-addon-landlock-run`）：Landlock 进程约束的源码记录处。
- 沙箱后端：bubblewrap（Linux）/ Landlock（Linux）/ Seatbelt（macOS）。
- node-pty（含本地 patch）：持久 PTY 后端，Windows 走 ConPTY。
- koffi（FFI）：JSONL Windows 写透发布。
- Loader 的 `node-addon-require-builtin` 可选原生 peer。

## 测试体系（vitest 多配置）

| 命令 | 配置 | 内容 |
|---|---|---|
| `pnpm run test` | vitest.config.ts | 单元测试 |
| `pnpm run test:coverage` | 同上加 coverage | **CI 覆盖门：`packages/*/*/src` 每文件 100%**（豁免清单在 scripts/coverage-exempt） |
| `pnpm run test:e2e` | vitest.e2e.config.ts | 真实 API 测试；无 `DEEPSEEK_API_KEY` 自跳过 |
| `pnpm run test:snapshot` / `:record` | vitest.snapshot.config.ts | 无密钥 ACP/headless 回放 vs 预期输出；录制需密钥 |
| `pnpm run test:web*` | vitest.web*.config.ts | 浏览器功能 / 性能 / 压测（先 `pnpm run build`） |
| pytest | pytest.ini | Python SDK |

测试策略要点：优先真实实现而非 mock；验证世界而非自报；测真实入口路径；解析只在源码面；子进程启动模式按声明（[docs/testing.md](../docs/testing.md)）。模型/用户可见行为变更须同 PR 加无密钥快照（经真实可运行示例的装配应用转录）。

## 质量门禁（本地可跑，CI 穷尽）

- `pnpm run typecheck` / `lint`（oxlint，经 `run-oxlint`）/ `duplication`（jscpd 跨文件克隆检测）。
- `pnpm run hygiene`：knip（死代码/未用导出）+ publint（入口点校验）+ workspace constraints（Project Reference 面）+ `verify-node-next-types`（NodeNext 消费者）+ `verify-cordis-config` + `verify-runtime-closure` + `verify-vendored-links` 等。
- `pnpm run doc-sync`：全部文档门（md 链接、换行、type-equiv、预算、翻译配对、生成目录新鲜度等）。
- Git 钩子（lefthook）：pre-commit 校验暂存的翻译配对记录、staged 档 oxlint、空白检查、vendor manifest 守卫；pre-push 跑 `typecheck`。翻译配对还有专用 Git merge driver。
- 聚合入口：`scripts/run-gates.ts`（`check:all` / `check:ci` / `doc-sync` 等模式，含并发与依赖编排）。

## 文档与网站

- 双语体系：`docs/**` 每篇英文 + `.zh.md` + `.i18n.yaml`（blob hash 一致性记录）；生成式目录（tool-catalog、config-catalog、persistence-catalog、module-graph、cordis-api、graph-atlas）从源码再生并新鲜度门禁，禁止手编。
- `website/`：VitePress 文档站，投影选定双语文档（构建即死链检查）。
- `.agents/notes/`：Agent Notes 决策记录（格式由 `verify-agent-note-format` 门禁）。

## 外部协议与集成

| 集成 | 形态 |
|---|---|
| DeepSeek API | `llm-deepseek` 适配器（`DEEPSEEK_API_KEY` / 可选 `DEEPSEEK_BASE_URL`） |
| pi-ai | `llm-pi-ai` 可选 LLM 后端（附 attachment 支持） |
| 回放 | `llm-replay` 测试支持适配器 |
| ACP | `packages/acp`：自动化专用 Agent Client Protocol 服务器（JSON-RPC stdio），同时是审批应答桥 |
| JSON-RPC SDK | `packages/sdk`：协议 + TS 客户端 + 服务器插件；Python 运行时分发同一协议 |
| Claude Code / Codex | `packages/hooks`：钩子桥 + 共享 wire-protocol 库；也是子代理 provider |
| E2B | `packages/e2b`：远程沙箱 POC（fs/subprocess provider 共享一个沙箱生命周期） |
| Web 搜索/抓取 | Exa、Perplexity、DeepSeek 搜索 provider + HTTP fetch provider，统一挂 `ctx.web` |
| OTel | `session-telemetry-otel` 会话遥测后端 |
| LSP | `lsp-local` 通用 stdio provider，归一化为恰好四种导航操作 |
