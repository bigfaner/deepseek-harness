# session —— 事件溯源日志

> [返回导读](README.md) | 上一篇:[02-scope.md](02-scope.md) | 下一篇:[04-system-prompt.md](04-system-prompt.md)

## 2.1 SessionEvent 信封:条件类型的教科书用例

```ts
// session/src/types.ts:408-440
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {          // 映射类型:对每个事件名 K 生成一个信封形状
    type: K
    seq: number
    time: number
    data: SessionEventMap[K]          // 索引访问:载荷类型与 tag 绑定
    ignorable?: true                  // 字面量 true:只许写 true,不许 false
  } & (K extends SurfaceEventType ? { // 条件类型:只有表面事件才有这两个可选键
    sourceEventSeqs?: number[]
    surfaceOp?: SurfaceOp
  } : object)                         // 否则交叉 object = 无新键
}[T]                                  // 再按 T 取出 → 判别联合
```

逐层翻译给 Java 读者:

1. `{[K in SessionEventType]: …}` 是**类型级 for 循环**,生成 `{ 'turn/start': 信封A, 'turn/end': 信封B, … }` 这样一个"以事件名为键的对象类型";
2. `& (K extends SurfaceEventType ? {…} : object)` 是编译期三元:三种类别事件(user/message、assistant/message、tool/result)的信封额外获得两个可选键,其余事件类型交叉 `object`(什么都不加)。**效果:给 `turn/start` 写 `surfaceOp` 是编译错误**;
3. 末尾 `[T]` 把这个对象类型按 key 取值。`T` 默认是全部键的联合,取出来就是所有信封的**判别联合**——Java 里等价的是 `sealed interface SessionEvent permits TurnStart, …` + 每个 record;
4. 之后 `switch (event.type)` 每个 case 里 `event.data` 自动 narrow 成对应载荷,等价于 JDK 21 的模式匹配 switch,而且是全仓铁律(不写 if 链)。

## 2.2 Session.append:一次追加的全部纪律

```ts
// session/src/index.ts:604-655(节选)
append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T> {
  const dataSnapshot = snapshotJsonValue(data)          // ① 校验+脱离一次完成
  if (dataSnapshot === undefined) throw new Error(`… non-JSON-serializable data`)
  const entry = attachments.get(this)
  if (entry?.appending) throw new Error('session append cannot reenter …')  // ② 禁止重入
  const event = deepFreeze({ type, seq: this.log.length, time: Date.now(), data: dataSnapshot, … })
  this.surfaceManager.validateNext(event)               // ③ 表面计划先验证(不提交)
  if (entry !== undefined) entry.appending = true
  try {
    let callbacks = … collectSessionCallbacks(…)        // ④ 先快照监听器(在 push 之前解析!)
    this.log.push(event)                                // ⑤ 提交:进日志
    this.eventsSnapshot = undefined                     //    失效缓存
    invokeContainedSessionObservers(…)                  // ⑥ 每监听器独立 try/catch,失败仅记日志
    return event
  } finally { entry.appending = false; … }
}
```

六个纪律:

1. 数据必须**无损 JSON**(`snapshotJsonValue` 拒绝 -0/NaN/稀疏数组/环/非固有原型——比 `structuredClone` 严,因为要保证落盘重放逐字节一致;getter 抛异常也无法"验证时一个值、存储时另一个值",因为只读一遍);
2. 追加不可重入(防止监听器里再 append 造成表面状态机错乱);
3. **先验证后提交**——表面管理器先"计划"(plan)不落状态,失败时零污染;
4. 监听器快照在 push 之前解析,保证观察者看到的是"已提交"事件;
5. `seq === log.length` 连续性契约;
6. 观察者失败被遏制(追加已提交,不能因监听器炸了而改变结果)。

事件入日志前 `deepFreeze`——**运行时**不可变,谁也改不了历史。

## 2.3 表面(surface)与 deriveMessages:模型历史是投影不是存储

`SurfaceManager`(`session/src/surface.ts:398-460`)维护 `nodes: number[]`(按序的表面事件 seq)和 `replaceGeneration` 计数器:

- `append` 类 surfaceOp → `nodes.push(seq)`;
- `{op:'replace', start, end}` → `nodes.splice(startIdx, endIdx-startIdx+1, seq)` 且 **`replaceGeneration += 1`**——这是"代际"失效信号,所有基于位置的缓存(派生消息缓存)看到代际变了就整体重建。

`validateNext` 先"计划"(`planSurfaceEvent` 返回 append/replace 计划但不改状态),候选事件进日志后由 `_processDelta` 惰性应用——两阶段 validate-then-commit。replace 的合法性检查相当严格:`start/end` 必须都是当前表面节点;`tool/result` 的 replace 只准遮蔽恰一个现有 `tool/result` 且**只许改 content**(`assertToolResultRewrite` 用"把双方 content 置空后深比较"来验证);`sourceEventSeqs` 必须引用**每一个**被遮蔽节点的 seq(审计线索)。

```ts
// session/src/index.ts:726-747(节选)
deriveMessages(): Message[] {
  const nodes = this.surface.nodes, generation = this.surface.replaceGeneration
  if (generation !== this.derivedGeneration) {          // replace 发生 → 缓存全部作废重建
    this.derived = []; this.derivedNodes = 0; this.derivedGeneration = generation
  }
  for (const seq of nodes.slice(this.derivedNodes)) {   // 增量:只投影没见过的节点
    const msg = this.deriveEventMessage(this.log[seq]!)
    if (msg) this.derived.push(msg)   // 空内容 assistant/message 投影为 null,不入历史
  }
  this.derivedNodes = nodes.length
  return [...this.derived]            // 新数组,共享内部冻结 Message(零深拷贝)
}
```

投影规则(`surface.ts:83-114`)极简:`user/message` → 原样整条;`assistant/message` → 其 `message`(空内容除外);`tool/result` → 其 `message`;**其余一律 null**(chunk、边界、todo、header)。增量缓存使每 step 的 `deriveMessages()` 只花 O(新节点)。

## 2.4 崩溃恢复 repair.ts

`interruptedTurnClosers`(`repair.ts:27-133`)单遍扫描日志,维护 `openTurn/openStep/pendingCalls: Map<CallId, {step, callSeq?}>`(`assistant/message` 的 tool-call 块登记、`tool/result` 配对删除、`tool/call` 补记"确实启动过"的 seq)。若日志终止在开放 turn 内,从 `last.seq+1`、复用 `last.time`(确定性,绝不发明未来时间)合成收尾:每个未配对调用补错误 `tool/result`(`TOOL_NOT_STARTED` 或 `TOOL_OUTCOME_UNKNOWN`——后者提示"仅只读/幂等才可重试"),再补 `step/end`、`turn/end{kind:'interrupted'}`。`interrupted` 结局**只有**恢复路径会写,活循环永不写。

## 2.5 SessionStore:prepare/enter/announce 三段式

`create()`(`index.ts:830-841`)是便捷路径,内部是一个 generator 效应:`yield enter(session); announce(session)`——**先 yield 拆卸器再 announce**,若 `session/created` 监听器同步抛错,已 yield 的拆卸自动回滚(generator 效应在抛错时执行已 yield 的清理),不会泄漏 store 条目。

- `enter`(:913-947)是权威的 id 冲突边界(两个 public 原语之间调用方可插入任意工作,所以 enter 重查);`announce`(:968-996)先置 `announced/announcing` 再派发——防监听器重入造出第二条生命周期边。
- `detachRequested` 闩锁:派发中请求拆卸 → 记下,`finally` 里等派发退栈后再执行,保证"每个监听器都见过活条目"+"created 先于 disposed"。
- `flush`(:1022-1039)是唯一的持久化检查点入口:`Promise.allSettled` 跑全部监听器,等所有 settle 后才抛首个失败;循环不在 turn 边界 flush(按请求的检查点策略归 `dsh-session-checkpoint-policy` 所有)。
