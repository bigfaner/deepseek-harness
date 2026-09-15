# 不变量伴随件与 dsh-llm 词汇

> [返回导读](README.md) | 上一篇:[07-agent-loop.md](07-agent-loop.md)

## 8. 不变量伴随件(invariants)

`dsh-invariants`(`packages/runtime-diagnostics/invariants`)是一个**默认开启**的运行时断言注册表:每包把检查放在独立 `./invariant` 入口,`ctx.invariants.register(pkgName, installer)`,violation 抛 `InvariantError`(fail-fast,非仅测试)。六个伴随件:

| 包 | 检查什么 | 何时 |
|---|---|---|
| scope | scoped 事件必须 carrier 派发且 key=主体 | `internal/dispatch` 前置 |
| session | turn/step/调用配对等关系约束 | **两阶段**:dispatch 前 pure 验证并暂存转移,`session/event` 后提交(被否决则丢弃暂存) |
| agent | `agent/status` no-op 迁移 | 监听器 |
| tools | pre→execute→post 单调阶段机;最终快照冻结;code-dispatch turn 围栏 | dispatch 前 + 事后 |
| system-prompt | 组装结果形状(名字唯一、文本 string、变量名合法) | waterfall 后前置监听 |
| agent-loop | 冻结请求的 messages JSON-等于 `deriveMessages()`、config/system/tools 等于折叠 header | `llm/stream` 前置(prepend,防被 replay 监听短路) |

session 的两阶段模式值得记:验证是纯函数(算出 `SessionTraceTransition` 挂在事件对象上),发布后再应用——被其它 dispatch 监听者否决时,暂存自然作废,零回滚代码。

## 9. core 之外但必读的词汇(dsh-llm 节选)

- **Message 族**(message.ts:129-156):`Message{id, role, content: ContentBlock[], source}`;`ToolResultMessage` 是 **user 角色**、content 恰一个 `[ToolResultBlock]`(元组类型——长度也是类型的一部分)、source `{kind:'tool', callId}`。构造器统一铸 `MessageId(randomUUID())` + 深冻。
- **ContentBlockMap**(types.ts:99-110):text/reasoning/image/tool-call/tool-result 五块,`ContentBlock = Map[keyof Map]` 派生,插件可合并扩展。
- **StreamChunk**(types.ts:312-324):block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish 七种,块索引关联交错增量;适配器保证 usage 先于 finish、finish 后无物。
- **BlockAssembler**(assembler.ts):chunk→message 的唯一规范组装器。`blocks()` 在 max-tokens 截断时**丢掉 tool-call 块**(不能安全执行);`interruptedBlocks()` 只保留有非空白内容的 text/reasoning(中断前缀);replayState 与块同步修剪防不一致。
- **Branded**(brand.ts):`type MessageId = Branded<'MessageId'>` + 同名铸造函数 `return id as MessageId`——`as` 断言纯编译期,运行时还是原字符串,**零分配**。
- **snapshotJsonValue vs structuredClone**:前者是"校验+拷贝"一体(拒绝一切 JSON 无法无损表达的:undefined/函数/symbol、非有限数、-0、环、稀疏数组、非固有原型、不可枚举键),后者只是结构拷贝。消息构造用后者(内容已信),**日志边界一律前者**。

## 附:贯穿 core 的五条工程格言

1. **一切可扩展类型都是 `Map[keyof Map]`**,一切扩展都是 declaration merging——不改拥有者的源码。
2. **先落盘后生效**:`tool/call` 先于执行、inbox 拼接先于投影、`request/header` 先于派发。
3. **模型可见 ⟺ 已记录**:每步从日志重新派生历史,不变量持续断言请求可从日志重建。
4. **取消是协作信号,永不弃置已启动的工作**:三路融合、信号重融合、ABORTED 只覆盖成功结局。
5. **拆卸顺序即语义**:精确的清理器身份、generator 效应嵌套、反向拆卸链——"注册即效应"的完整闭环。
