# tools —— 注册表与五阶段执行管线

> [返回导读](README.md) | 上一篇:[04-system-prompt.md](04-system-prompt.md) | 下一篇:[06-agent.md](06-agent.md)

## 4.1 ToolDefinition:输出契约是强制项

`tools/src/index.ts:222-288`。比常见"工具=名字+参数+函数"多出的关键件:

- `output`(必填):`{schema, render(args,value), presentationMeta?}`。**执行体只返回 canonical JSON 值**,模型可见内容由 `render` 纯函数投影——这使同一个值可以分别服务模型(内容)和 UI(meta),且事后可重放。
- `finalizeContent?`:同步"最后一英里"内容变换,**每个规范化结局恰执行一次**(包括绕过 post-execute 的管线失败,:1631-1646)。
- `timeoutMs`(声明式,由别的包的 `tools/execute` 包装器执行,注册表本身不管)/`isConcurrencySafe`(仅精确 `true` 才可并行)/`presentCall/presentResult`(纯函数,重放容错)。

## 4.2 view():一次遍历算出"这个作用域看得见什么"

`view(scope)`(:1152-1193)是注册表读侧的全部真相:

```ts
// tools/src/index.ts:1160-1192(节选)
const layers = this.layers.chainLayers(scope)   // 祖先链(远→近)
const own = this.layers.peek(scope)             // 本作用域自己的层(链盲!)
const inherited = new Map(this.layers.global.tools.entries())
for (const layer of layers) { if (layer === own) continue
  for (const [name, d] of layer.tools.entries()) inherited.set(name, d) } // 近遮蔽远
for (const [name, d] of inherited) {
  knownNames.add(name); restrictableNames.add(name)
  if (layers.every(layer => layer.admits(name))) visible.set(name, d)  // 掩码沿链相交
}
if (own !== undefined) for (const [name, d] of own.tools.entries()) visible.set(name, d)  // 自己的注册不受掩码限制
if (this.modeFor(scope) !== 'native') visible.set(RUN_CODE_NAME, this.requireCodeTransport()) // 传输件在过滤之外
```

三条精心设计:

1. **掩码只过滤"继承面"**(子 agent 上报工具注册在自己层里,不能被能力过滤器剥掉);
2. **code 模式的 `run_code` 传输件插在一切过滤之外**(任何 restrict 都删不掉它);
3. `modeFor`(:900-911)沿链取最近的 `presentAs` 声明,没有则取部署默认。

## 4.3 执行管线五阶段(核心 300 行)

**阶段一 createExecution**(:1364-1451):铸 symbol token;快照+深冻结参数;**先捕获 finalizeContent 再物化参数**(注释:参数 getter 可能在物化中换掉回调);code 折叠的调用在**进入策略管线之前**就以 final-result 终止(注释:预执行监听器绝不能"批准"一个注定失败的调用),且拒绝消息带"应该怎么走"的路由名(:1441)。

**阶段二 prepareExecution**(:1463-1507):`tools/pre-execute` waterfall(allow/deny/ask);`ask` 走 `serviceAsk`(:1689-1729)——`ctx.get('approval')` 机会主义取用,无审批服务/无 agent 则**降级为 deny**(四种拒绝原因让模型能区分"用户说不"与"没有审批通道");然后单调 guards(:1119-1128,全局层+作用域链,任一返回字符串即拒,**没有 allow 结果所以监听器顺序无法把拒绝翻回允许**);每个异步门后重查调用方取消。

**阶段三 dispatchToolBody**(:1532-1560)——信号融合是亮点:

```ts
// tools/src/index.ts:1536-1548(节选)
const wrapperSignal = exec.signal
const fused = fuseToolSignals(state.callerSignal, wrapperSignal)  // 把包装器换的信号与原始调用方信号"并联"
exec.signal = fused.signal
try {
  const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
  if (!tool) throw new ToolNotFoundError(exec.name)
  state.bodyInvoked = true
  const returned = await tool.execute(exec.arguments, exec)
  const result = this.createSuccessResult(exec, tool, returned)
  return isAborted(signal) ? toolAbortedResult(result) : result    // 取消只"覆盖成功结局"
} finally { fused.dispose(); exec.signal = wrapperSignal }
```

`fuseToolSignals`(:1889-1916)手写并联两个 AbortSignal(不用 `AbortSignal.any` 以便 settle 后摘掉监听):任一先 abort 就把 reason 传给新 controller。**动机**:`tools/execute` 环绕包装器(超时/重试)可以替换 `exec.signal`(那是 `ToolDispatchExecution` 上唯一可变字段),但注册表把替换信号与**原始调用方信号**融合后再喂给工具体——包装器无论如何也无法把调用方的取消剥离掉。

取消语义:体启动后取消只把成功结局替换为 `ABORTED`(已启动的 promise 永不弃置);启动前取消是 `ABORTED_BEFORE_DISPATCH`。

**阶段四 postExecute**(:1742-1781):`tools/post-execute` waterfall。`accept` 可换 `content` **或** `value` 之一(同时给两个抛 TypeError);换 `value` 会**重新走一遍输出契约**(重新 schema 验证+render,:1764-1774);`block` 把纠正反馈变成 isError 结局。工具体 `deferContext` 的上下文在 accept 时保留、block 时丢弃。

**阶段五 finishScheduledExecution**(:1631-1646):物化(无损 JSON+冻结)→ `finalizeContent` → 再物化 → `Object.freeze(exec)` 后发只观察的 `tools/result`(每监听器独立遏制)。

成功路径的输出契约(`createSuccessResult`,:1793-1823):快照值 → `validateJsonSchemaValue`(违例=INVALID_TOOL_OUTPUT)→ `render` → 快照 → 顶层调用才算 `presentationMeta` → `concludesTurn` 标记。包装器自制的结果经 `normalizeDispatchResult`(:1826-1844)**同样被输出契约归一**——WeakMap<结果, token> 标记"已规范化",防止双重验证/绕过。

## 4.4 调度分阶段:TOOL_RUNTIME_SCHEDULER

注册表暴露内部符号接口 `prepare/dispatch/finalize/finish`(:451-460)给 agent-loop 的调度器(见 [07-agent-loop.md](07-agent-loop.md)):**只有 dispatch(执行体)允许重叠**,prepare(有序策略)与 finalize(post+物化)保持模型序。这是"并行执行但结果有序"的解耦点——Code Mode 桥(code-mode.ts)实现同一接口,复用同一契约。

## 4.5 schema.ts:类型级魔法(defineTool DSL)

`defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>`(:545)——`const` 类型参数让 `{type:'string', const:'red'}` 保持字面量类型不宽化。然后:

```ts
// tools/src/schema.ts:150-166(骨架)
type InferValueAt<S, Depth extends unknown[]> =
  Depth['length'] extends 16 ? JsonValue :        // ① 元组长度计数,16 层封顶
    S extends { type: 'string' } ? InferScalar<S, string> :
      …
      S extends { type: 'array' }
        ? S extends { items: infer I } ? InferValueAt<I, NextInferenceDepth<Depth>>[] : JsonValue[]
        …
type InferScalar<S, F> =
  S extends { const: infer C } ? C :              // ② const:'red' → 类型 'red'
    S extends { enum: readonly (infer E)[] } ? E : F   // ③ enum:['a','b'] → 'a'|'b'
```

给 Java 读者:这是**编译期递归类型函数**,在类型层面"解释执行"你的 schema 声明,推导出执行体的参数/返回类型。`Depth['length']` 是索引访问(读元组 `length` 属性的类型——字面量数字);`NextInferenceDepth<Depth> = [unknown, ...Depth]` 每层加一个元素,长度到 16 就放弃推断回落 `JsonValue`(保证编译器终止)。`infer I` 是模式解方程。Java 没有任何等价物——最接近的心智模型是"注解处理器在编译期生成的类型",但 TS 把它写进了类型语言本身,且零运行时成本。

运行时侧:`defineTool` 在定义期就把 DSL 编译成 JSON Schema(迭代编译器 `runSchemaCompiler`,:275-414——显式任务栈而非递归,深 schema 不炸调用栈;`seen` 集合检测环,共享引用 OK 真环抛错;object 必须显式 `additionalProperties: boolean`)。返回的 `execute` 入口硬验证参数(违例抛 `INVALID_ARGS`);`presentCall/presentResult/isConcurrencySafe` 则**软验证**(违例回退 undefined/false,不抛)——因为呈现器会在**重放旧日志参数**时被调用,旧 schema 的参数不该炸掉今天的 UI(:594-615)。
