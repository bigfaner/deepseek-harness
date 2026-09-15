# 核心流程一：启动与组合

> 独立梳理导读；权威来源：[packages/boot/app-boot/README.md](../packages/boot/app-boot/README.md)、[docs/architecture.md](../docs/architecture.md) 的 Profiles and bundles 一节。本文描述 `dsh` 从命令行到插件树存活的完整路径。

## 总览

`dsh` 二进制（`apps/cli`）是薄壳：真正的启动胶水在 `@deepseek-ai/dsh-app-boot`。一次启动可概括为：

```text
dsh bin（薄壳组合）
  → 分层环境解析 loadLayeredEnv（继承环境 > 项目 .env > 用户 .env）
  → 解析 profile 目录（$DSH_HOME/profiles/<name>，缺省模板自动初始化）
  → loadProfile：读取 dsh.profile.bundles 有序清单（双锚点解析：dsh 安装树优先，其次 profile 目录）
  → composeEntries：对空 entry 列表依序应用各 bundle 的 patch 层
  → 叠加 profile 级 cordis.patch.yml → home 级 cordis.patch.yml → --patch 命令行覆盖
  → boot()：创建根上下文 + 安装 Cordis Loader + 挂载 include 树
  → assertEntriesActivated：等待每个启用条目激活，失败带原始栈响亮退出
  → watchUserPatches：注册用户 patch 文件的 HMR 监听
```

## 环境与凭据

- 启动早期构建冻结的环境快照：**继承环境 > 调用目录 `.env` > Harness home `.env`**；每个值记录来源，bootstrap 专用变量从文件层拒绝。接受值物化进 `process.env` 供 Loader 表达式与第三方库使用。
- 凭据不进配置：配置携带引用，`credentials-local` 以 env 覆盖 `.env` 的方式解析值；托管凭据在 Harness home 的 `.credentials.yaml`。
- 源码检出运行时，根目录 gitignored `.env` 提供 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`）。

## Profile 解析与层叠

- profile 目录含 `package.json`：树外插件 `dependencies` + `dsh.profile` 清单（有序 `bundles`）。`loadProfile` 双锚点解析每个 bundle 名（安装树第一锚，profile 目录第二锚），清单里没有 bundle 声明的包**响亮失败**。
- 安装拥有的精确 bundle 元组会被归一化为出厂模板；清单一旦增删重排即归用户所有，原样保留。
- patch 层语义：id 定位的 patch **整体替换**目标行 `config`（保留字段要重述），`insert` 增行，`!!js` 表达式在挂载时求值（仅 `config` 与 `disabled` 字段允许）。命中不存在 id 的 patch 是 stderr 警告；空文件（只含注释）抛错——要禁用该层写 `[]`。
- 层序固定：**bundle（按 profile 列出顺序）→ profile patch → home patch → 命令行 overlay**，因此越靠后优先级越高。
- `healProfilesModuleFallback` 维护 `$DSH_HOME/profiles/node_modules` 平铺符号链接，使任意 profile 里的裸插件名能经 Node 普通父级遍历解析，无需 pnpm 管理盒内包。

## 挂载与激活

`boot()` 做四件事并在任一步失败时**处置部分上下文后抛带标签的错误**：

1. 创建根上下文，向 Loader 的 `!!js` 配置表达式暴露 `dshHomePath(...)`。
2. 注册静态内建的 `cordis:include` 与 `cordis:group`（group 使组合能给一组 provider 及消费者同一 `isolate` realm）。
3. 挂载 include 树（Loader 并发挂载条目；`inject` 声明的服务依赖决定激活顺序）。
4. `assertEntriesActivated`：先查已启用却无 fiber 的条目（点名每个未解析插件），再等待每个启用条目——失败者带原始栈、pending 者点名未满足的服务。

裸包名（`@deepseek-ai/dsh-*` 或 npm 包）默认从配置目录解析；封闭运行时传 `bareModuleBaseUrl` 使已安装包树保持权威。相对说明符永远相对配置目录。

## 失败的响亮路径

- `installFailLoud` 把未处理的启动/Loader 拒绝变成一行带标签的 stderr + `exit(1)`；可选 `release` 钩子在被有限超时等待后先行恢复终端（终端属主面在退出前复原 raw mode 等）。
- Loader 并发挂载意味着某面可能已拥有终端：`boot()` 对配置树失败的处置会先跑该面自己的关闭逻辑；`dsh` 在 `prepare` 钩子里捕获根上下文以覆盖整个挂载窗口。

## 运行中重组合（HMR）

- 每次带 profile 的启动用 `watchUserPatches` 监听用户 patch 文件：新增/变更/删除事务性地经调用方的 `compose` 闭包重组完整 patch 清单（bundle 层在下、overlay 在上）。
- 读/解析/Loader 候选被拒时，最后一棵好树继续运行，HMR 服务广播 `hmr/config-update-failed`；观察者失败被隔离。
- Cordis 自带的 `cordis-plugin-hmr` 使插件重载的注册回退可预期——这正是"注册即效应"的回报。

## 内省与排障

- `dsh --profile <name> --dump-config`：用 include 自己的解析器与 patch 算法离线组合，渲染等于实际挂载结果的可加载 YAML（`!!js` 原样保留），同源同层的行块前有 `# ==` 注释标明来源文件与层。
- 快照回放模式（`snapshotMode === 'replay'`）把 `cordis.yml` 基名换成兄弟 `cordis.snapshot.yml`。
- `PROFILE_TEMPLATES` 内置 `web`（浏览器 UI，默认 `http://127.0.0.1:3080`）与 `headless`（一次性运行器、无服务器）两个模板；ACP 自动化服务器（JSON-RPC stdio）是 examples 下的独立 bin（`pnpm run demo:acp`），不经 profile 模板。

## 谁在树上：典型 profile 的内容

`dsh-base` 是每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。`dsh-web-app` 在其上加浏览器应用；`dsh-headless` 加一次性运行器。用户 patch 可替换树上任意行——这正是"一切皆插件"组合层的兑现。
