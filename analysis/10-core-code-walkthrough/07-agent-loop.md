# agent-loop —— 默认驱动器

> [返回导读](README.md) | 上一篇:[06-agent.md](06-agent.md) | 下一篇:[08-invariants-and-llm.md](08-invariants-and-llm.md)

## 7.1 AgentLoop 服务(index.ts)

`static inject = ['agents','sessions','llm','tools','systemPrompt']`(:297)——声明即依赖,加载顺序由 Cordis 解析。构造器做四件事:

1. `ctx.agents.setFactory(this)`(:350);
2. 注册 prompt 变量 provider/model/cwd(:351-353);
3. 装 settings 节 `agent-loop`,注意 `config.maxParallelToolCalls` 是 **getter**(:331-333)——settings 提交后下一组工具就生效,无需重启;
4. 为每个 config agent 启动(restore 或 create)。

`restoreOrCreateConfigured`(:407-428)的容错很讲究:resume 失败后,只有当持久化列表里**确实没有**这个 id 才回落 create——损坏/后端错误保持大声失败。

## 7.2 prepare():一次创建的全部事务性

`index.ts:459-578`。三路取消融合(:479-487):调用方 signal ⊕ owner fiber 卸载 ⊕ 工厂拆卸,任一触发即 abort setup。反向拆卸链(:497-520)记忆化(`disposing ??= …`):

```text
dispose(): abort → machine.cancel({kind:'disposed'}) → await machine.whenIdle()
           → await machine.scope.dispose()   ← 作用域回退(所有插件注册)
           → detachAgent?.() → detachSession?.()   ← 最后才脱离注册表
           → untrack() → unfollowOwner()
```

顺序就是语义:先让驱动器静默(最后的 turn 事件得以发布),再回退作用域,最后从注册表消失——`agent/disposed` 才不会在最后一轮还在跑时就发出。`publish`(:556-570)四次 `assertLive()` 穿插在 enter/announce/session-start 之间:同步监听器可能随时触发拆卸,每步之后重查。`setupAndPublish`(:625-645)用 `using ownedPreparation = preparation`(`Symbol.dispose` ≈ try-with-resources):setup 在**插入/发布之前**跑完,任何失败自动回滚、双 id 都不发布。

## 7.3 ReactLoopAgent 状态机(agent.ts)

`Phase`(:38-46)是私有三态:`idle{lastTurn} | maintenance{abort,lastTurn,wakeRequested} | running{abort,turn,step,wakeRequested}`;对外 `status` 只报 `idle|running`(maintenance 也报 idle,:99-101),`setPhase` 只在真实迁移时发 `agent/status`(no-op 迁移被不变量拒绝)。

**wakeDriver**(:172-193):空闲 → 记忆 `activityDone`、置 running、`loopCtx.agents.withInitiator(this, () => this.kick())`(整条驱动链带 initiator);非空闲(maintenance 或已 abort)→ **闩锁** `wakeRequested` 等 convergence;`disposed` 取消永不闩锁(拆卸不等模型轮)。`send`(:113-120)里 `wakingAfterAbort` 在插入**之前**捕获(防重入 cancel 重分类):已中止活动中的唤醒输入改道 next-turn——中止轮结束后开新轮。

**kick**(:210-223):`while (await this.turn()) {}` 排空队列;错误在驱动边界吞掉(已在 throwError 发过 `agent/error`);finally 回 idle,闩锁唤醒且 inbox 非空才重放。无后台轮询。

## 7.4 turn():一轮的 14 个要点

`agent.ts:246-330`,按代码顺序:

1. `turn/start` 落盘(先开轮再认领输入);
2. `preStep(target)`(:225-243):`inbox.claim` → `systemPrompt.assemble(assembleContextFor(this, signal))` → runtimeContext 投影(文本变了才产出快照消息)→ `agent/pre-step` waterfall(默认 enter:认领消息+可能的上下文快照);
3. **reject → turn/end{blocked},无 step**;turn 首步空消息 → `completed` 不烧模型调用(:274-277);
4. `step/start`;每条进入消息落 `user/message`(surfaceOp append);
5. `step(assembly)`;**max-tokens 粘性**(:290):后续 completed 不降级;
6. `finally step/end`;
7. **停车门**(:295-299):`turnEnds && inbox.nextStep 空` → `agent/turn-stopping` serial → 再查 inbox → 空才 break。反对者往 next-step `steer()` 一条即续命——**steer 的实现就是"让 next-step 非空"**;
8. 错误:abort → `turnEnds={kind:'aborted', reason:signal.reason}` 重抛;其他 → 结构化(`LlmError` 保 facts,否则 `errorChain` 文本 + UNKNOWN)→ `throwError`(发 `agent/error` 再抛);
9. `finally turn/end`(每个出口都赋了 turnEnds);
10. 队列还有 → **换新 AbortController**、`step=0`、返回 true,kick 再来一轮(:324-329)。新控制器使旧信号上闩的 wake 失效——活驱动器自己会认领队列。

## 7.5 step():一次模型请求 + 工具批次

`agent.ts:332-420`,内层 `while(true)` 支持 retry:

- **buildRequest**(:426-514):种子 = agentOptions(首步)或持久 header 剥掉 adapter 默认(`requestProposal`,:54-61——`adapterDefaults.reasoningEffort === true` 表示"这值是适配器给的默认",换模型时该删);`agent/request` waterfall 可补 provider/model;`llm.prepareCall` 解析适配器默认(容忍 NO_ADAPTER——中间件可能服务未注册路由);`request/header` 首次/变更时落盘、`request/context` 路由变更时落盘;最终 `markAgentLoopRequest(deepFreeze({...config, messages: boundaryMessages, system, tools, sessionId, signal}))`——**冻结且带标**(不变量插件靠此标记在 `llm/stream` 断言 messages JSON-等于 `deriveMessages()`,即"模型可见⟺已记录")。
- **流式**(:343-371):每 chunk 落 `assistant/chunk`(记 seq)+ `assembler.push`。**中止但已有交付块**:以 `interrupted:true` 落一条 `assistant/message`(sourceEventSeqs 引用块 seq)——下一请求自然带上用户已见前缀。
- **finish error/aborted**(:373-389):`agent/request-error` waterfall;仅 `{kind:'retry'}` 且不调 next() 的监听者拥有恢复,continue 重试;否则抛 `LlmError`。
- **成功**(:392-409):`assistant/message`(带 usage、sourceEventSeqs);max-tokens 直接返回;无 tool-call 块 → completed;有 → `executeToolCalls`,`concluded` → completed,否则 null(同轮下一步)。

## 7.6 tool-calls.ts:有界滚动池(调度器核心)

`executeToolCalls`(:59-101)按 `executionMode` 分组:exclusive 首调用独自成屏障组;parallel 取剩余全部后缀。`runGroup`(:121-246):

- `startCall`:**先落 `tool/call`**(执行前持久)→ `prepare(exec)` 三分支(dispatch/post-result/final-result);
- `fillPool`(:198-213):`inFlight < cap` 持续启动;**启动前重分类**(:203-204)——某调用模式翻转为 exclusive 就此打住,留给外层下一屏障(注释:有序 commit 后注册表可能已变);
- 排空循环(:218-235):`Promise.race(inFlight)` → settle 后 `commitReady` 只提交**模型序连续**的槽位(:146-160):`finalize`(需 post)或 `finish`,落 `tool/result`(sourceEventSeqs 引用 callSeq),`additionalContexts` 经回调前插 next-step,OR 累计 concludesTurn;
- abort(:237-241):已启动的照常结算,未启动的每个补**合成** `tool/call+tool/result` 对(`ABORTED_BEFORE_DISPATCH`,:249-259)——重放时日志依然配对合法;
- 调度器失败:停新派发、`allSettled` 在飞、原样重抛首个失败——**绝不伪造结果**(:231-235)。

给 Java 读者:`Promise.race(map.values())` 是"任意一个完成即醒"的等待原语(race 返回首个 settle 的 index);"只提交连续槽位"保证**结果落盘顺序 = 模型给出的顺序**,即使执行乱序完成。

## 7.7 runtime-context.ts:三态字段的用法

`retained: {seq,text} | null | undefined`——`undefined`=从未有过快照,`null`=有过但已不保留(被 replace 遮蔽)。构造时倒序扫日志找最后一条 system-prompt 拥有的表面 user/message;`project(current)` 文本相同就不产出(去重),空 current 产 `CLEARED` 标记。产出的是**未提交**消息,由 turn 流程决定是否落盘。
