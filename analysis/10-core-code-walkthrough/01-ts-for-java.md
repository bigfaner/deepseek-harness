# TypeScript 高级语法速成(Java 对照)

> [返回导读](README.md)。本篇是读后续所有代码的前提:先立三个 Java 没有的心智模型,再用两张对照表覆盖 core 源码里出现的全部高级构造。

**最重要的一个事实:TS 的类型系统是编译期的一门小函数式语言,运行时 100% 擦除。** Java 泛型擦除到 `Object`,TS 连泛型本身都不存在——`SessionId` 品牌类型在运行时就是那个原始 string,`never`、`keyof`、条件类型全部不产生任何字节码。所以本仓敢把大量"聪明"写在类型上:零运行时成本。

## 三个心智模型

### 1. 品牌(零成本 newtype)

```ts
type SessionId = Branded<'SessionId'>              // = string & { readonly [BRAND]: 'SessionId' }
function SessionId(id: string): SessionId { return id as SessionId }   // 铸造器,as 纯编译期
```

运行时它**就是原来那个 string,零分配零拆箱**;但编译期你没法把 `CallId` 传给要 `SessionId` 的参数。类型和值是两个命名空间,所以 `type SessionId` 和 `function SessionId` 可以同名共存。

### 2. 判别联合 + 声明合并 = 一切扩展性的根

```ts
// ≈ Java: sealed interface + record + JDK21 模式匹配 switch
type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }
```

`switch (d.kind)` 后每个分支自动收窄(narrow)。而"声明合并"是 Java 完全没有的能力:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { agents: AgentRegistry }     // 给别人的接口"远程加字段"
  interface Events { 'agent/created'(...): void } // 多个包的声明合并成同一个接口
}
```

`interface` 同名即合并——**每个包都能给全局 `ctx` 加服务、给全局事件表加事件,不改任何拥有者的源码**。全仓的 `…Map → derived-union` 模式(`SessionEventMap`、`ContentBlockMap`)就是它 + 索引访问:

```ts
type SessionEvent = SessionEventMap[keyof SessionEventMap]   // 取值的联合
```

### 3. Cordis ≈ Spring

| Cordis | Spring 最近对照 |
|---|---|
| `ctx`(Context) | `ApplicationContext` + 类型安全的 getter 合体 |
| `Service`(认领 `ctx.tools` 等 key) | `@Service` Bean,按 bean name 暴露 |
| `static inject = ['tools']` | `@Required` 依赖声明(决定激活顺序) |
| `ctx.plugin(X)` | 注册并启动一个 Bean/子容器 |
| fiber | 子容器/生命周期域(`ConfigurableApplicationContext` 的可拆卸版) |
| `ctx.effect(...)` 返回清理器 | `DisposableBean.destroy()` + try-with-resources,且可精确嵌套 |
| `declare module` 给 `Context`/`Events` 加成员 | 给 ApplicationContext 生成强类型 getter(编译期) |
| `emit/waterfall/serial/parallel` | 事件广播 / 责任链(可改写)/ 顺序 await / 并行 await |

## 类型系统构造对照表

| TS 构造 | 出现位置(示例) | Java 最近对照 | 一句话 |
|---|---|---|---|
| 结构化类型 | 全仓 | 无(Java 是名义类型) | 形状匹配即可赋值,不需要 `implements`。`{ x: number }` 类型的参数可传任何有 `x` 的对象 |
| `interface` 声明合并 / `declare module` | 每个包的 `declare module '@deepseek-ai/cordis'` | 无 | 给**别的包**的接口"远程加成员",多方合并成一个接口。本仓一切扩展性的根 |
| 判别联合 `A \| B`(带字面量 tag) | `PreStepDecision`、`TurnEndReason`、`StreamChunk` | `sealed interface` + `record` + JDK21 模式匹配 switch | 一个"或类型",按 tag 字段 narrow |
| `…Map → derived-union` | `SessionEventMap`、`ContentBlockMap` | sealed 继承树的"注册表版" | 接口当注册表,`Map[keyof Map]` 派生联合;插件合并新 key 即扩展 |
| 字面量类型 `'idle' \| 'running'` | `AgentStatus` | 枚举常量的类型版 | 该字段只能是这几个字符串;运行时就是普通 string,不是 enum 对象 |
| 条件类型 `T extends U ? A : B` | `SessionEvent` 信封、`InferValue` | 无 | 编译期三元表达式,类型级 `if` |
| `keyof T` / 索引访问 `T[K]`、`T['length']` | `TurnEndReasonMap[keyof TurnEndReasonMap]` | 反射 `getDeclaredMethods` 的类型版(编译期) | 取 key 的联合 / 按 key 取值类型 |
| 映射类型 `{[K in U]: ...}` | `SessionEvent` 信封 | 无 | 类型级 `for (K : keys)` 生成对象类型 |
| `infer X` | `InferValue`、`InferScalar` | 泛型捕获/unification | 在 `extends` 模式里"解方程",求出 X |
| 递归条件类型 | `InferValueAt<S, Depth>` | 无(Java 泛型不能自调用求值) | 类型函数递归;用元组长度计数限制深度 16 防不终止 |
| 分配性条件类型 | `RequiredKeys<S>` | 无 | 联合类型遇上裸类型参数的条件判断会"逐成员展开再合并" |
| 交叉类型 `A & B` | `SessionEvent<T> & { surfaceOp }` | 多继承接口(但 TS 无限制且是结构的) | 必须同时满足两者 |
| 工具类型 `Pick/Omit/Extract/Exclude/Record/Partial/Readonly` | 到处 | Guava Range/collectors 的类型版 | 内置的类型级集合运算 |
| 品牌类型 `Branded<B>` | `SessionId`、`CallId`、`MessageId` | newtype/包装类(但零分配零拆箱) | `string & { readonly [BRAND]: B }`:结构上还是 string,类型上不可互换 |
| `unique symbol` | `TOOL_RUNTIME_SCHEDULER`、`kScope` | `enum` 单例 / `new Object()` 做锁 | 全局唯一的编译期已知 key |
| 同名 type + function | `type SessionId` + `function SessionId()` | 无 | 类型和值是两个命名空间,可同名:函数是零成本"铸造器" |
| `this` 参数 | `'agent/created'(this: Scoped<Agent>, ...)` | 无(Java this 隐式定死) | 假装的第一个参数,只约束函数体内 `this` 的类型 |
| 可选属性 `?` | `ignorable?: true` | `@Nullable Optional` | 缺省即"键不存在";本仓开 `exactOptionalPropertyTypes`,显式 `undefined` 也不行 |
| `readonly` / `readonly T[]` | 全仓 | `final` 字段 / `List.of()` | 只挡编译期赋值和 `push`;运行时不可变靠 `Object.freeze` |
| `const` 类型参数 / `as const` / `satisfies` | `defineTool<const S...>` | 无 | 让字面量保持最窄类型(不宽化成 string);`satisfies` 校验但不宽化 |
| `never` + `assertNever` | 每个 exhaustive switch | sealed + 模式匹配的穷尽检查 | 漏一个分支 → 该分支参数类型是 `never` → 编译错 |
| 类型谓词 `x is T` / 断言签名 `asserts x is T` | `isSurfaceEvent`、`asserts schema is JsonSchemaNode` | 无 | 普通函数,但返回 true / 正常返回后,编译器收窄调用方类型 |
| 泛型默认值 `<T extends X = X>` | `SessionEvent<T = SessionEventType>` | 无(Java 无参数默认值) | 不传参时取默认 |

## 运行时构造对照表

| TS/JS 构造 | 出现位置 | Java 最近对照 | 要点 |
|---|---|---|---|
| `Promise` / `async-await` | 全仓 | `CompletableFuture` + 假想的顺序语法 | 单线程事件循环上的"将来值";`await` 不占线程 |
| `Promise.withResolvers()` | 驱动器、registry | `new CompletableFuture<>()` 手动 complete | `{promise, resolve, reject}` 三件套,自己掌握完成权 |
| `Promise.race` / `allSettled` | 调度器、resume | `CompletableFuture.anyOf` / `allOf` | race 首个 settle 者胜;allSettled 等全部(不抛) |
| `AbortController`/`AbortSignal` | 贯穿 loop→tools→llm | `Future.cancel(true)` / 线程中断标志的**正确**版 | 传递的是信号不是线程;监听者协作式响应,绝不强杀 |
| `AsyncLocalStorage`(ALS) | initiator 作用域 | Loom `ScopedValue`(按异步链而非线程) | `als.run(v, fn)` 内的整个异步延续都能 `getStore()` 读到 v |
| generator `function*` + `yield` | Cordis `ctx.effect` | 无(概念上是"可暂停的 try 块") | 本仓把它当**拆卸脚本**:先 yield 注册器,失败自动回滚已 yield 的 |
| `using` / `[Symbol.dispose]()` | `SessionPreparation` | try-with-resources / `AutoCloseable` | 语法糖 → try/finally 调 `dispose()` |
| `WeakMap`/`WeakSet` | 执行簿记、不变量 | `WeakHashMap`(注意 key 弱) | 不阻止 key 被 GC;本仓用它挂"每对象私有状态"且不泄漏 |
| async iterator `for await...of` | 流式消费 | Reactive Streams `Publisher` | 拉式异步序列 |
| 参数属性 `constructor(private readonly x)` | `SurfaceManager` 等 | Lombok `@RequiredArgsConstructor` | 编译器生成字段+赋值 |
| 解构/剩余/条件展开 | `...cond ? {} : {k:v}` | 无 | "键存在与否"的运行时表达,和 `?` 可选属性是一对 |
| `??` `?.` `??=` | 到处 | `Optional.map/orElse` 的语法糖 | 只对 null/undefined 短路(不是 falsy) |
| `Object.freeze`/`deepFreeze` | 日志、消息、结果 | `Collections.unmodifiableList` 深度版 | **运行时**不可变;和编译期 `readonly` 互补 |
| `structuredClone` / `snapshotJsonValue` | append 边界 | `clone`(序列化版) | 前者结构拷贝;后者**校验+拷贝**一体,拒绝 JSON 不能无损表达的值(-0、NaN、稀疏数组、环…) |

下一篇:[02-scope.md](02-scope.md) —— 作用域原语。
