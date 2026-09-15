# agent —— 公共契约(附两个小包)

> [返回导读](README.md) | 上一篇:[05-tools.md](05-tools.md) | 下一篇:[07-agent-loop.md](07-agent-loop.md)

## 5.1 Agent 接口(runtime-types.ts:64-144)

纯 interface,零 loop 依赖——所以 loop 可整体替换。给 Java 读者翻译几个签名:

```ts
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
//  ↑ 统一原语;followup/steer/inject 是它的三个固定预设(next-turn+唤醒 / next-step+唤醒 / next-step+不唤醒)
cancel(cause: AgentCancelCause, options?: CancelOptions): void
//  ↑ cause 是判别联合 {kind:'user'}|{kind:'parent'}|{kind:'hook',reason}|{kind:'disposed'}
whenIdle(): Promise<void>
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
//  ↑ 泛型方法:每个调用点独立推断 T(Java 的 <T> 方法)
```

`AgentCancelCause` 是"TypeScript 强制的同进程输入":跨进程来的只能是序列化数据,不可能凭空造出这个判别联合的引用——取消原因天然不可伪造。

## 5.2 Inbox:先持久、后投影

`agent/src/inbox.ts:158-193` 的 `mutate` 是全包最精巧的 20 行:

```ts
private mutate(target, start, deleteCount, inserted, discardRemoved): UserMessage[] {
  // …规范化 splice 参数(截断/负索引/钳制)…
  const splice = { target, start: actualStart, …, inserted, … }
  this.validate(splice)                                    // ① 越界/重复 id 校验
  const event = this.session.append('agent/inbox/spliced', splice)  // ② 先落盘
  const removed = inbox.splice(actualStart, actualDeleteCount, ...event.data.inserted)  // ③ 再改活投影
  …
}
```

**顺序即契约**:先 append 持久事件再变更内存列表——同步的 `session/event` 观察者读到的是**变更前**状态,可从规范化坐标重建被删消息。Inbox 构造时从 seed 之后重放所有 `agent/inbox/spliced` 折出现状(:32-39)——"重放一次的投影",resume 后队列原样恢复。`claim`(:71-78)是 loop 专用步边界操作:取走**全部 next-step** + turn 首步时**恰一条** next-turn;持久拼接是纯删除(不产生 canceled 结局),因为"认领"不是"取消"。

## 5.3 dispatch.ts:融合派发器(防"路由键与主体分叉")

```ts
// agent/src/dispatch.ts:113-118
const fused = <K extends AgentSubjectEvent>(payload: PayloadRest<K>): PayloadOf<K> =>
  ({ ...payload, agent })        // spread 在前:调用方就算传了 agent 字段也盖不掉注入的主体
```

`agentEvents()`(:107-149)返回 `{emit, serial, waterfall}` 三方法,每次派发都以构造时建好的 carrier 作 thisArg 并把 agent 注入载荷首位。emit 为什么不走 Cordis 原生?注释(:121-126):Cordis emit 用 `Array.map` 调监听器,**一个同步抛错会饿死后续监听器**——所以自己解析回调集合并逐个 try/catch。类型侧的 `AgentSubjectEvent`(:28-34)用类型级过滤挑出"载荷带 agent 且 this 是 Scoped<Agent>"的事件名,泛型 `emit<K>` 的参数类型就自动对了——Java 里这得靠重载或手动 cast,TS 在类型层完成了。

## 5.4 AgentRegistry:工厂 + initiator

- `setFactory`(:372-388):loop 启动时注册自己。若传入的是 Cordis 跟踪代理,用 `factory[symbols.original] ?? factory` 拆到具体目标(防代理层叠加);返回**精确的** effect 清理器。
- `create/resume`(:405-430):`getTraceable(ownerCtx, target)` 把调用重新挂到**调用方** context 上再 `Reflect.apply`——所有权跟调用者走,不跟注册者走(Java 里相当于 AOP 动态代理换 invocation context)。
- initiator 作用域(:259-260):两个 `AsyncLocalStorage`。给 Java 读者:**AsyncLocalStorage ≈ Loom ScopedValue**,但作用域跟随**异步延续**而非线程——`withInitiator(agent, op)` 里 `op` 无论 await 多少层,内部 `currentInitiator()` 都能读到 agent。`withoutInitiator` 用 `als.run(undefined, …)` 真正**遮蔽**外层值(给惰性定时器/泵用,防误继承首个 agent)。teardown 时先 `closing`(拒新边界)再 drain 所有未完结边界,`releaseReentrantInitiatorRuns` 排除"自己触发自己卸载"的链防死锁(:640-703)。

## 5.5 model-selection.ts:两个瀑布听众的"快照-应用"配对

`installModelSelection`(model-selection.ts:39-75):`system-prompt/assemble` 监听器在 `await next()` **之前**快照当前选择、之后把 provider/model 盖进 prompt 变量;`agent/request` 监听器 `await next()` 后应用的是**组装时快照**而非实时值。净效果:中途切换模型,下一步才生效,prompt 与请求永不割裂。注意 :60 的解构惯用法:`const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved`——把一个键挑出去、其余收进新对象(选择无 effort 时**清空**继承值,而不是保留)。

## 6. 两个小包

### agent-default-model(107 行全部读完)

构造函数把 config `{provider, model}` 存为组合项 `entry`,settings provider 挂载后 `setSource` 把 `this.source` 换成活读闭包——`currentSelection()` 每次经 `selection()` 投影(含 `ReasoningEffortId` 品牌转换)。`reasoningEffort` 故意**不在** Config 里:这样已保存的选才能把它清空。`saveSelection` 无 settings 时静默 no-op。

### agent-tool-presentation(72 行全部读完)

preset 里的"呈现行"。`native` 立即 `ctx.tools.presentAs('native')`;`code/both` 用 `ctx.inject(['codeRuntime'], …)` **等**运行时注入——`inject` 不写在插件级,是为了 native 行能挂在没有 code 运行时的部署上(可选后端惯用法)。等不到 → 挂载保持 pending → `dsh-agent-presets` 拒绝该 preset 并点名此插件 id,而不是首条提示词才炸。
