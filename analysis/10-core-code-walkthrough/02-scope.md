# scope —— 作用域原语(159 行核心)

> [返回导读](README.md) | 上一篇:[01-ts-for-java.md](01-ts-for-java.md) | 下一篇:[03-session.md](03-session.md)

两个文件:`index.ts`(204 行,API 与事件过滤)、`store.ts`(267 行,分层存储)。

## 1.1 ScopeKey:对象身份即作用域

```ts
// scope/src/index.ts:15
export type ScopeKey = object
const kScope = Symbol('dsh.scope')                    // :18
const scopeParents = new WeakMap<ScopeKey, ScopeKey>() // :39
```

- `ScopeKey = object`:任何对象都能当 key。**活 agent 对象本身就是自己的作用域 key**(见 [07-agent-loop.md](07-agent-loop.md) 中 `createScope(loopCtx, this)`),零分配、引用相等即匹配——类似 Java 里直接拿 `this` 当 `IdentityHashMap` 的 key。
- `kScope` 是个 symbol(≈ 全局唯一枚举实例),用作 context 上的"隐藏字段名":symbol 键不会被普通代码枚举到,天然私有。
- `scopeParents` ≈ `WeakHashMap<ScopeKey, ScopeKey>` 存父子关系。注释(:33-38)点明**一条关系驱动两个方向**:注册视图沿链**向下**继承(子可见祖先的层),事件准入沿链**向上**放行(祖先的监听器能收后代的事件)。

## 1.2 createScope:挂 fiber + 打标签

```ts
// scope/src/index.ts:137-147
export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = ctx.plugin(scope)                       // 挂一个空插件,得到独立 fiber(≈ 子容器)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })  // 派生 context 并打标签
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),  // ??=:首次调用才创建,幂等
  }
}
```

要点:

- `ctx.plugin(scope)` 挂载空插件函数 `scope`(:121),Cordis 为它开一个 fiber。之后**经 `scoped` 注册的一切**都是这个 fiber 的"效应",fiber 卸载时全部按序回退——这就是"agent.ctx 的贡献随 agent 消失而消失"的实现根基。
- `{ [kScope]: key }` 是计算键对象字面量(symbol 作键);`extend` 派生新 context,标签随派生继承、最近者遮蔽。`scopeOf(ctx)`(:154-156)就是读这个标签——一个 `O(1)` 的属性读。
- `dispose` 用 `??=` 记忆化(Java 写法:`if (d == null) d = …; return d;`);`quiesceFiber`(:115-118)先 `await fiber.dispose()` 再循环 `await fiber.inertia` 直到静默——保证并发调用者等同一个完成信号。

## 1.3 scopeTarget:作用域过滤的事件载体(本包最核心的 15 行)

```ts
// scope/src/index.ts:170-185
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {     // Cordis 约定:带此符号方法的对象可作派发 thisArg
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      const tag = scopeOf(ctx)          // ← 读"监听器注册 context"的标签(不是派发者的!)
      if (tag === undefined) return true             // 无标签 = 全局监听器,放行
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true              // tag 是 key 或其祖先 → 放行(事件上行)
      }
      return false                                    // 子作用域监听器收不到父作用域事件
    },
  }
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}
```

机制拆解:Cordis 派发事件时会拿 `thisArg` 上的 `[filter]` 方法,对**每个监听器的注册 context** 调一遍来决定送达。这里构造的 carrier 的 filter 逻辑是:"监听器的作用域标签要么没有(全局),要么在派发 key 的祖先链上"。于是:

- `agent.ctx.on('agent/status', …)` 注册的监听器带 A 标签 → 只收 A(及 A 后代)的事件;
- 普通 `ctx.on(...)` 注册的 → 收所有。

返回类型 `Scoped<T>` 是品牌类型(:27),唯一构造口是本函数——配合不变量插件(`scope/src/invariant.ts:20-31`,挂在 Cordis 内部 `internal/dispatch` 上做前置检查):**凡声明为 scoped 的事件,必须拿 carrier 派发,且 carrier 的 key 必须等于载荷里指名的主体对象**。"路由键"与"事件主体"在类型与运行时双重不可分叉。

## 1.4 ScopedLayers:全局层 + 作用域覆盖层(所有注册表的地基)

`store.ts` 三个类:

- `NamedEntries<V>`(:30-105):`Map<string, V>` 包装,`insert` 重名抛调用方给的错误,返回幂等撤销器。撤销后若表空,**换新 Map**(:52)——"排空代际"边界,让正在迭代的旧迭代器与后续插入隔离。
- `AnonymousEntries<V>`(:114-150):`Map<symbol, V>`,每次 `append` 铸新 symbol——值相等也是两次独立注册(工具 provider、guard 这类"无名扩展点"需要)。
- `ScopedLayers<L>`(:159-267):注册表核心。

```ts
// scope/src/store.ts:226-266(节选)
effect(ctx: Context, action: (layer: L) => () => void, options): () => void {
  const scope = scopeOf(ctx)                 // 调用方 context 决定:可见性 + 效果归属 二合一
  const dispose = ctx.effect(function* (this: ScopedLayers<L>) {   // generator 效应
    // ...惰性创建 scope 层 → action(layer) 拿同步撤销器(抛错则回收新层)
    yield () => {                            // yield 出"拆卸步":Cordis 卸载时调用
      undo()
      if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)  // 整层空才回收
      if (notify) this.onChange()
    }
    if (notify) this.onChange()
  }.bind(this), options.label)
  return dispose   // 返回"精确的" ctx.effect 清理器——函数身份承载 Cordis 嵌套拆卸顺序
}
```

给 Java 读者的解释:`ctx.effect(function*(){ yield cleanup })` 是 Cordis 的"可逆注册"惯用法——generator 同步执行到 `yield` 完成注册,`yield` 出去的函数就是拆卸器(概念上像"把 finally 块作为值交出去")。如果 generator 在 yield 前抛错,已 yield 的拆卸器自动执行 → 天然回滚。**注释里的 `oxlint-disable` 强调必须原样返回这个函数**:Cordis 按函数身份去重嵌套,包一层 lambda 会让拆卸变成"并发兄弟"而不是"嵌套子步骤"。

读取侧:`merge(scope, pick)`(:208-217)先 global 插入序,再 `chainLayers(scope)`(自远祖到最近,:192-199)同名覆盖——**就近作用域说了算**。`peek(scope)`(:180)故意"链盲":只看本作用域自己的层(限制掩码这种"只属于自己的东西"不能捡祖先的)。
