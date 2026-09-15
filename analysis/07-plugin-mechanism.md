# 插件机制：原理、生命周期与开发指南

> 独立梳理导读；权威来源：[docs/cordis-primer.md](../docs/cordis-primer.md)、[docs/cordis-tutorial/](../docs/cordis-tutorial/index.md)、[docs/cordis-api/](../docs/cordis-api/)（生成的 API 参考）、[docs/cookbook/extension-cookbook.md](../docs/cookbook/extension-cookbook.md)，以及 vendored 框架源码 [vendor/cordis/src/](../vendor/cordis/src/)（本地修改日志见 [vendor/README.md](../vendor/README.md)）。本文把"一切皆插件"（见[架构总览](01-architecture-overview.md)）落到机制层：Cordis 运行时构件、fiber 生命周期状态机、插件作者实操指南。

## 总览

底座 Cordis 被源码内嵌（vendored，重 scope 为 `@deepseek-ai/*`）而非 npm 依赖：harness 完全拥有自己的框架层，可审计、可修补、版本钉死，发布 harness 即随附发布。本地对 fiber 生命周期做了多项加固（重入销毁缺口、事务性配置回滚、Include 串行化等，完整清单见 vendor/README.md 的 Local modifications）。

```text
┌─ 配置组合层   profile → bundles → cordis.patch.yml → --patch（YAML 行 + patch 层叠）
├─ 加载层      cordis-plugin-loader / include / group / hmr（vendor/）
├─ 内核层      cordis：Context(Proxy) · Fiber(生命周期) · Registry · Reflect(服务解析) · Events
├─ 插件层      200+ 个 @deepseek-ai/dsh-* 包（packages/<group>/<pkg>）
└─ 入口层      apps/cli（dsh 命令）· apps/web · examples/*/cordis.yml
```

一个关键澄清先行：本 vendored 版本是 cordis 的 **fiber 化重写**——没有 `definePlugin`、没有 `ctx.on('ready')`/`'dispose'`/`'hmr/before-reload'` 生命周期事件、没有 `ctx.cleanup()`。"生命周期"完全由**效应（effect）系统**承载：插件注册的每个效应的清理器就是它的 dispose 钩子，`apply` 顺利跑完就是 ready。Context 上也没有 `ctx.dispose()`/`ctx.reload()`，对应能力在 fiber 上（`fiber.dispose()`/`fiber.restart()`/`fiber.update()`）。

## 原理

### 五个核心概念（公理层）

| 概念 | 含义 | 机制载体 |
|---|---|---|
| 插件 = Service 实现 | 函数（带可选 `inject`/`Config`）或 `Service` 子类 | `Plugin<T>` 联合类型（`vendor/cordis/src/registry.ts:92`） |
| Context = 服务仓库 | 服务认领稳定 key（`ctx.tools`、`ctx.llm`…），按键查找而非导入实现 | Reflect Proxy（`vendor/cordis/src/reflect.ts:135`） |
| `inject` 声明依赖 | 命名所需服务的插件等待其就绪；加载顺序由服务需求表达，非手工编排 | Fiber epoch 机制（`vendor/cordis/src/fiber.ts:611`） |
| 类型化事件 | declaration merging 声明事件名，按语义选派发模式 | `EventsService`（`vendor/cordis/src/events.ts:131`） |
| 注册即可逆效应 | 一切贡献经 `ctx.effect()`/`ctx.on()` 安装，卸载可预期回退 | `Fiber._disposables`（`vendor/cordis/src/fiber.ts:415`） |

### 运行时四大构件

**Context 是一个 Proxy**。`new Context()` 返回 `Proxy<this>(this, ReflectService.handler)`。读取 `ctx.tools` 时，get 陷阱沿 fiber 链向上查找每个祖先 fiber 的 `store`，且要求 `name in fiber.inject` 才允许读取——否则抛经典错误 `cannot get property "x" without inject`（`reflect.ts:144`）。"依赖必须声明"由此在语言层强制。子作用域走原型链：`ctx.extend(meta)` = `Object.create(traceable(this))`，父上下文不可变。`ctx.on`/`ctx.plugin`/`ctx.effect`/`ctx.get` 等方法本身也是 `mixin()` 挂载的效应（`reflect.ts:219`）——内核自举与插件使用同一套机制。

**Fiber 是一次插件装载的运行时句柄**（不是插件本身）。`ctx.plugin()` 每次调用创建一个新 fiber；同一插件 callback 可有多个 fiber（isolate 多实例时）。核心是 **epoch 机制**：`_runner.epoch` 是编码依赖身份的字符串（`''` 或 `':uid1:uid2...'`），任一依赖服务的 provider fiber uid 变化即 epoch 变，fiber 自动卸载重载。这是"换一个 provider 即改变整个产品"的实现根基。

**Registry 以 callback 为身份键**。`_internal: Map<Function, Plugin.Runtime>`（`registry.ts:197`）：函数插件与其 `{apply: fn}` 对象形态是同一个插件（`resolve()` 把后者解析为 `apply` 函数）。Runtime 记录（name/fibers/callback/Config）被同 callback 的所有 fiber 共享。

**Reflect 是服务解析与 ctx 表面层**。管理 `store`（按隔离域 symbol 键的 Impl 表）与 `props`（声明的 service/accessor 属性）；`notify(names)` 是依赖重算的扇出引擎：服务变化 → 重新检查所有注入该服务的 fiber → `_refresh()` → 发射 `internal/service`。

### 服务模型

- **提供**：`class MyService extends Service` 构造时 `super(ctx, 'myKey')` → `ctx.reflect.provide(name, self)`。服务只在 provider fiber **ACTIVE 后可见**（`reflect.ts:294`）。
- **消费**：`inject: ['myKey']` 声明硬依赖（fiber 保持 PENDING 直到服务存在）；`ctx.get('myKey')` 是可选探测（未提供时 undefined，插件照常运行）。
- **替换**：无原地替换 API——旧 fiber 卸载（服务消失 → 依赖者卸载 → PENDING）→ 新 fiber 提供（依赖者以新 epoch 重新激活）。provider 销毁时 `Promise.allSettled` 等待所有依赖 fiber 稳定后才移除自身 store（`reflect.ts:300`），保证清理期间依赖者仍能访问服务完成自己的清理。
- **隔离**：`ctx.isolate(name, label)` 让两个同 key 服务共存（如两个不同配置的 `shell` provider）；服务查找在隔离标签变化处停止（`reflect.ts:153`）。

### 事件系统：派发模式即公共契约

| 模式 | 是否等待 | 顺序 | 返回值 | 典型用途 |
|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | 观察广播（`internal/status`） |
| `waterfall` | 否 | 注册序环绕 | 有 | 策略拦截（`tools/pre-execute`） |
| `parallel` | 是 | 并行 | 无 | fan-out，`AggregateError` 聚合 |
| `serial` | 是 | 注册序 | 有 | 有序决策（`agent/turn-stopping`） |
| `bail` | 否（同步） | 注册序 | 有 | 同步首中即停 |

**waterfall 即环绕中间件**：监听器收到 `(...args, next)`，调 `next()` 委托（可改写结果），不调即短路否决（含内建行为）。观察/注解型监听器必须委托；拥有决策权的才短路。`prepend: true` 仅用于必须先行的监听。派发模式用 `@mode` 标注，生成目录据此校验声明与派发点一致。

监听器注册时 rebind 到调用者上下文（`reflect.bind`），监听器内 `ctx` 永远是注册时作用域；监听器随 owner fiber 卸载自动移除，不存在手动 `off`。

### 组合机制（衔接）

配置文件（`cordis.yml`）是 YAML 行数组，每行 `{ id, name, config }`，`name` 即 npm 包名/相对模块路径。加载链：`boot()` 创建根上下文 → `ctx.plugin(Loader)` → 挂载 `cordis:include` 根条目 → Include 解析 YAML（`!!js` 延迟求值）→ Group 组装行 → Loader 按 name import 模块、读取命名导出 `name`/`inject`/`Config`/`apply` → 为每行创建 fiber → `assertEntriesActivated` 审计。层叠顺序（bundle → profile patch → home patch → `--patch`）与 `id` diff 热更新语义见[启动与组合流程](04-boot-and-composition.md)。

## 生命周期

### Fiber 状态机

状态定义在 `fiber.ts:147`（`const enum FiberState`）：

```text
                          依赖未满足/丢失
              ┌──────────────────────────────────┐
              ▼                                  │
 PENDING ──依赖齐──▶ LOADING ──apply 成功──▶ ACTIVE ──dispose/restart──▶ UNLOADING
    ▲                 │                            │                        │
    │                 │ apply/config 抛错           │                        ├─ 依赖恢复 ─▶ LOADING（热替换）
    └────────── FAILED（记住错误，epoch 复位）      │                        └─ settle ──▶ PENDING / DISPOSED
                                                   │
                      fiber.dispose()（永久）────▶ DISPOSED（不可重启）
```

每次状态变化发射 `internal/status(fiber, oldState)`；跨 ACTIVE 边界的转换还会触发该 fiber 所提供服务的重新通知（`fiber.ts:589`）。可观测钩子共四个 `internal/*` 事件：`plugin`（fiber 创建/清除）、`status`、`config`（每次激活前的配置 waterfall）、`update`（`fiber.update()` 环绕 waterfall）。

### 加载路径（`_reload()`，`fiber.ts:646`）

1. `ctx.plugin()` → 创建 fiber（PENDING），同步发射 `internal/plugin`；
2. 逐个 `_checkImpl` 检查 inject 的服务（含服务自带 `check` 谓词）；全齐 → 计算 epoch → 状态 LOADING；
3. 快照 store（`this.store = {...this._store}`），依赖实现在此刻定型；
4. `await Promise.resolve()` 检查点——让排队中的销毁请求先使本次加载失效；
5. epoch 未变 → `internal/config` waterfall 解析配置 → schema 验证（失败抛 `ValidationError`，fiber FAILED，进程按"误配置响亮失败"原则退出）；
6. **`apply(ctx, config)` 本身作为一个 effect 运行**：执行期间每个 `ctx.on/provide/mixin/plugin` 调用按调用序把 wrapper 推入 `fiber._disposables`；`apply` 返回值（清理器/Promise/迭代器）最后收集；
7. settle → ACTIVE（或 FAILED：错误记入 `_error`，`fiber.await()` 会 rethrow）。

### 卸载路径（`_unload()`，`fiber.ts:675`）

1. 触发源：依赖丢失 / `fiber.restart()` / `registry.delete()` / 父 fiber 卸载；
2. `_disposables.clear()` 取**逆注册序**快照 → 各 wrapper **并发**运行（`Promise.all`），每个 wrapper 内部自己的清理器逆序串行；
3. **错误包含**：单个清理器抛错只记录日志，不中断兄弟清理；
4. `store = undefined`——注入的服务从此不可读；
5. settle：epoch 为 INACTIVE → PENDING/DISPOSED；epoch 已变 → 直接链入 LOADING（热替换循环）。

**顺序保证**：子 fiber 的 detach effect 注册在**父 fiber** 的 disposables 里（`fiber.ts:265`），逆序保证子插件先于父插件较早的效应卸载。单个 fiber 内：apply 期间注册的效应（事件、服务、子插件）先清，然后 apply 自身返回的清理器，最后 `ctx.plugin()` 的结构效应。

### 依赖热替换（epoch 循环）

```text
provider 卸载 ─▶ 服务消失 ─▶ notify() 重算依赖者 ─▶ 依赖者 epoch 变 ─▶ UNLOADING
                                                                    │
provider' 挂载 ─▶ 服务出现 ─▶ notify() ─▶ 依赖者 epoch 齐活 ─────────┴─▶ LOADING ─▶ ACTIVE
```

换掉一个 `ctx.fs` provider，所有注入 `fs` 的插件（bash、fs 工具、LSP…）自动卸载并以新实现重载，无需插件代码配合。进行中的转换（`inertia`）不可重入：转换中到达的新 epoch 被记录，由正在运行的转换自己链接后续（`fiber.ts:625`）。

### HMR：fiber 之上的薄层

`cordis-plugin-hmr` 监视模块文件：保存 → 卸载对应 fiber → 重新 `ctx.plugin()`。全部可逆性来自效应系统（"注册即效应"的回报）。配置文件变更走 `fiber.update(config)`：校验 → `internal/update` waterfall（默认监听器执行 restart，HMR 可否决/替换）→ 重启。

### 实用 API

| API | 语义 |
|---|---|
| `fiber.await()` | 等待惯性排空；FAILED 时 rethrow 启动错误 |
| `fiber.restart()` | 置 INACTIVE → refresh → await（完全重载） |
| `fiber.update(config)` | 校验新配置 → `internal/update` waterfall → 重启 |
| `fiber.getEffects()` | 取带 label 的效应树（诊断用 EffectMeta） |
| `fiber.state` / `fiber.uid` / `fiber.name` | 状态/身份/诊断名 |

## 开发指南

### 插件形态与最小模板

```ts
// ① 函数插件（最常用）
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'          // 诊断显示名（loader 行的 name 则是模块说明符）
export const inject = ['tools']          // 硬依赖：tools 未就绪则保持 PENDING
export interface Config { greeting: string }
export const Config: z<Config> = z.object({ greeting: z.string().default('hello') })
export async function apply(ctx: Context, config: Config) { /* ... */ }

// ② 对象插件：{ name?, inject?, Config?, apply(ctx, config) }
// ③ 类插件：export default class extends Service { constructor(ctx) { super(ctx, 'myKey') } }
//    构造后自动跑 [symbols.initHooks] 与 [symbols.init]（fiber.ts:251）
```

**隐蔽陷阱**（`isConstructor` 判定，`vendor/cordis/src/utils.ts:79`）：非 async 的 `function apply` 有 `.prototype`，会走**构造器路径**——函数体照常执行，但返回值被丢弃（构造器路径返回 `symbols.init` 的结果）。若 `apply` 要返回清理器/Promise/生成器，必须写成 `async function` 或箭头函数（`packages/mcp/mcp-client/src/index.ts` 有显式注释）。

### 配置

`Config` 用 vendored schemastery 声明（兼容任意 Standard Schema v1 验证器；纯对象不行）。无效配置 → `ValidationError` → fiber FAILED → 进程退出，绝不半配置启动。YAML 中 `!!js` 表达式只允许出现在 `config` 与 `disabled` 字段：前者在声明的注入激活后针对该插件 ctx 求值，后者在每次挂载决策时针对 loader ctx 求值。

### 提供与消费服务

```ts
// 提供方：声明合并补类型
export default class GreeterService extends Service {
  constructor(ctx: Context) { super(ctx, 'greeter') }
}
declare module '@deepseek-ai/cordis' {
  interface Context { greeter: GreeterService }
}

// 消费方
export const inject = ['greeter']   // apply 内 ctx.greeter 保证存在；provider 变化自动重载
// 可选探测：const g = ctx.get('greeter')  // undefined 时不阻塞，插件照常运行
```

命名规范见 [docs/cookbook/adding-a-package.md](../docs/cookbook/adding-a-package.md) 的角色词表（Registry/Provider/Backend/Runtime/Policy…）：单数 key 对单引擎，复数 key 对注册表；服务名是扁平命名空间，自有服务要加前缀。

### 监听事件

```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (!(await isAllowed(exec))) return { kind: 'deny', reason: 'policy' }  // 短路
  return next()                                                             // 委托
})
```

规则：观察/注解型监听器必须调 `next()`，拥有决策权的才短路。工具管线四个事件分工：`tools/pre-execute`（策略门）/ `tools/execute`（包裹分发生命周期：超时重试指标）/ `tools/post-execute`（结果变换）/ `tools/result`（不可变最终结果的包含式观察）。选型规则见 [docs/cookbook/adding-a-tool.md](../docs/cookbook/adding-a-tool.md)。

### 注册模型可见的工具

```ts
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'my_tool',
    description: '…',
    parameters: { query: { type: 'string', required: true, description: '…' } },
    output: { schema, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { /* exec.agent.session.append(...) 记会话事件 */ },
  }))
}
```

`defineTool` 把参数 spec 转 JSON Schema 并推断类型；注册自动加入 prompt 组装，注册本身是效应，卸载即回退。按 agent 限定工具集时用该 agent 的 `agent.ctx` 注册（scoped layers）。**模型可见 ⟺ 已记录**：新模型可见输入必须新增 `SessionEvent`（见[Agent 循环与会话流程](05-agent-loop-and-session.md)）。

### 资源清理

```ts
ctx.effect(() => {
  const timer = setInterval(tick, 200)
  return () => clearInterval(timer)      // 清理器
})
// 也支持返回 Promise<disposer> 或 async 生成器（长驻循环体，epoch 翻转自动中止）
```

顺序敏感的清理要**放进同一个效应**：多个 async 清理器之间是并发的，只有单一效应内部才逆序串行。在 DISPOSED/UNLOADING 的 fiber 上注册效应抛 `CordisError('INACTIVE_EFFECT')`。

### 从单文件到工作区包

- **快速实验**：`examples/*/cordis.yml` 加一行 `- name: './my.ts'`，`node --import tsx vendor/cordis/bin.js` 直接跑，HMR 保存即重载。
- **正式包**：`packages/<group>/<pkg>/`，按 [docs/cookbook/adding-a-package.md](../docs/cookbook/adding-a-package.md) 清单——`@deepseek-ai/cordis` 同时进 peer/dev deps（host 供单例）；`exports["."]`/`["./invariant"]`；每包配 **invariant 伴侣插件**（`src/invariant.ts`，`inject: ['invariants']`，向 `ctx.invariants` 注册持久日志形状校验）；README 需含 Model Experience 与 Known Limitations 规范段。门禁：`pnpm run constraints && typecheck && lint && build && hygiene`。
- **带浏览器面的包**：host 侧 `apply` 可为空（占位行），client 代码走 `exports["./client"]` + `package.json` 的 `dsh.client` 声明（参考 `packages/extensions/ui-cordis`）。

### 调试

"插件没反应"的第一嫌疑人永远是 **PENDING = inject 未满足**（合法静默状态，不会拉住事件循环）：

```ts
for (const runtime of ctx.registry.values())
  for (const fiber of runtime.fibers)
    if (fiber.state === FiberState.PENDING) console.log(fiber.name)
```

boot 结束时 `assertEntriesActivated` 会点名列出 pending（含缺失服务名）与 failed 的行。`dsh --profile <name> --dump-config` 离线查看整棵树。

### 特性 → 机制速查（精选）

| 目标 | 机制 |
|---|---|
| 加模型提供商 | `ctx.llm.registerAdapter()`（`LlmAdapter` 子类） |
| 加模型可见能力 | `ctx.tools.register()`，schema 自动进 prompt |
| 拦截请求/工具/回合 | `agent/*`、`tools/*` 事件（waterfall） |
| 加人类命令（无模型回合） | `ctx.commands` |
| 加后台工作 | `ctx.jobs`；`job_*` 工具收集/停止 |
| 文件系统/策略 | `ctx.fs` provider 或 `fs/*` 事件 |
| 注入模型可见上下文 | `agent.inject()`，落在下一个获准请求 |
| 持久会话状态 | 扩展 `SessionEventMap`，从日志渲染与重放 |
| MCP 接入 | 每服务器一插件：发现工具 → `ctx.tools.register()` |

完整映射见 [docs/cookbook/extension-cookbook.md](../docs/cookbook/extension-cookbook.md) 的 feature → mechanism 表——每个产品特性对应一个有文档的扩展点，微内核声明的可检验化。

## 权威文档索引

| 主题 | 位置 |
|---|---|
| 框架源码（fiber 化重写版） | [vendor/cordis/src/](../vendor/cordis/src/)（fiber.ts 是生命周期心脏） |
| 官方教程（7 篇，含中文） | [docs/cordis-tutorial/](../docs/cordis-tutorial/index.md) |
| API 参考（生成） | [docs/cordis-api/](../docs/cordis-api/)（context/fiber/registry/service/events） |
| 入门 primer | [docs/cordis-primer.md](../docs/cordis-primer.md)（[中文](../docs/cordis-primer.zh.md)） |
| 扩展形态 cookbook | [docs/cookbook/extension-cookbook.md](../docs/cookbook/extension-cookbook.md) |
| 建包清单 | [docs/cookbook/adding-a-package.md](../docs/cookbook/adding-a-package.md) |
| vendor 同步规程与本地修改日志 | [vendor/README.md](../vendor/README.md) |
