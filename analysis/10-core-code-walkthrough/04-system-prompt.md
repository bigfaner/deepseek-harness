# system-prompt —— 请求前缀组装

> [返回导读](README.md) | 上一篇:[03-session.md](03-session.md) | 下一篇:[05-tools.md](05-tools.md)

## 3.1 PromptLayer:又一座 ScopedLayers

```ts
// system-prompt/src/index.ts:304-335(节选)
class PromptLayer implements ScopeLayer {
  readonly sections: NamedEntries<PromptSection>       // 有名:作用域同名遮蔽全局
  readonly contexts: NamedEntries<PromptContext>       // 有名:动态上下文(落盘为 user 快照)
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  readonly toolProviders = new AnonymousEntries<ToolProvider>()  // 无名:全局+作用域都贡献
  readonly variables: NamedEntries<VariableProvider>()
```

注意分节/上下文/变量用 `NamedEntries`(**遮蔽**语义:preset 的 persona 覆盖全局 persona),工具 provider 用 `AnonymousEntries`(**并集**语义:每个 provider 都出 schema)。构造函数(:353-371)注册两个固定分节:`harness:identity`(order -100)和 `deployment:persona`(order 0,内容来自 config.persona)——preset 要换 persona 就在同作用域注册同名分节,靠名字碰撞实现替换。

## 3.2 assemble:九步组装

`assemble(context)`(index.ts:467-542)顺序:

1. 取作用域链;
2. 解变量(全局先、链上"远→近",就近同名胜——:478-482);
3. merge 分节/上下文(遮蔽);
4. 跑全部工具 provider,`structuredClone(parameters)` 脱离 + `knownNames` 并集(:487-503);
5. 按 `order` 排序、>1 个 `complete` 段抛错;
6. `orderTools` 应用配置的 toolOrder(必须有 `<unlisted-tools>` 锚点,未列者字典序填入);
7. 过 `system-prompt/assemble` waterfall(**返回值权威**,scoped 派发);
8. waterfall 后强制恢复 complete 段为唯一分节/清空被抑制的 contexts(:536-541)——监听器无法绕过 complete;
9. 产出 `PromptAssembly{sections, contexts, tools, variables}`(全部**未插值**)。

渲染独立:`renderPrompt`(212-217)把每个分节过 `interpolate` 后过滤空串、以 `\n\n` 连接。`interpolate`(:258-295)是手写扫描器:

- 找 `{{`,用正则 `GROUP_AT` 匹配完整组;
- 变量名校验、`Object.hasOwn` 防原型链(`__proto__`/`toString` 不能冒充变量);
- 未知/undefined 引用**抛错**(严格模式:提示词里引用没注册的变量是 bug 不是空串);
- 替换值**不二次扫描**(防注入);
- 孤立的 `{{` 若后面没有 `}}` 当普通文本。

动态上下文(`PromptContext`)的落盘去重由 [07-agent-loop.md](07-agent-loop.md) 的 `RuntimeContextProjection` 完成:文本与上一条快照相同就不产出新消息,空 current 产 `CLEARED` 标记。
