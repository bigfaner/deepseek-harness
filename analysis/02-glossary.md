# 关键术语表

> 独立梳理导读；权威来源：[docs/glossary.md](../docs/glossary.md)（一词一义）与 [docs/cordis-primer.md](../docs/cordis-primer.md)。本表按域分组给出中文释义，括号内保留英文原词，便于对照源码与英文文档。

## Cordis 框架层

- **插件** — 实现 Cordis `Service` 的对象：带可选 `inject` / `apply(ctx)` 的函数，或 `Service` 子类。dsh 的一切组成部分（模型适配器、工具、会话日志、循环本身）都是插件。
- **上下文** — 服务的仓库。服务认领稳定的 `ctx.<key>`（如 `ctx.tools`），其他插件按键查找而非导入具体实现。
- **服务** — 挂载进上下文、拥有稳定 key 的功能单元。可分为核心脊柱服务、可替换能力接缝、组装点三类。
- **`inject` 依赖声明** — 插件命名所需服务，等待其就绪后再激活；加载顺序由服务需求表达。
- **效应** — 经 `ctx.effect()` / `ctx.on()` 安装的可逆注册；返回清理器，插件卸载时按序回退。"注册即效应"是全仓铁律。
- **类型化事件** — 以 TypeScript declaration merging 声明、按 `emit` / `waterfall` / `parallel` / `serial` 四种模式派发的事件；模式属于事件公共契约，JSDoc 以 `@mode` 标注。
- **瀑布/环绕中间件** — `ctx.waterfall` 派发：监听器收到 `(...args, next)`，调 `next()` 委托（可改写值），不调即短路。短路的监听器拥有该决策，只观察的必须委托。
- **`isolate` realm** — Cordis `cordis:group` 组合给予一组 provider 及其消费者同一隔离 realm，常用于 agent preset 的服务行。

## 组合与启动层

- **profile（配置档）** — Harness home `profiles/<name>/` 下的命名组合：`dsh.profile` 声明有序 bundle 列表，目录持有树外插件与用户 `cordis.patch.yml`。`web`、`headless` 为内置模板。
- **bundle（捆包）** — Cordis 配置行 + 所挂代码的发行格式（`dsh.bundle` 指向 patch 文件）；其插入的行仍可被上层 patch。
- **patch 层** — 按 id 整体替换目标行配置或插入新行的覆盖层；层序为 bundle → profile patch → home patch → `--patch` 命令行覆盖。patch 不深合并，保留字段需重述。
- **Harness home** — `$DSH_HOME`（默认 `~/.dsh`）：profiles、用户 `.env`、`.credentials.yaml`、home 级 patch 所在地。
- **fail loud（响亮失败）** — 误配置在加载期或最早可解析点抛错；绝不静默跳过缺失引用。
- **源码面 / 构建面** — 静态门禁与测试经 tsconfig `paths` 指向 `src`；消费构建产物 `lib/` 的门显式声明依赖，两者不混。

## 循环层级

- **turn（轮）** — 对一次被接纳输入的完整排空：从认领第一段输入前开启，到模型与工具都不再亏欠、或终局策略介入时关闭。一个 turn 含零或多个 step。
- **step（步）** — 一次模型请求 + 其响应引发的全部工具执行。
- **round（外层轮）** — 包含一个 turn 的外层策略迭代，如 goal round 或 Ralph 的一次全新 agent 尝试；计数属于该策略，不数会话里每个 turn。
- **inbox（收件箱）** — 输入到达驱动器的唯一通道。部分消息立即唤醒驱动器，注入的上下文则在收件箱等待下一条消息。
- **next-step input（下一步输入）** — step 之间可被认领的挂起输入；存在时循环继续下一个 step。

## 会话与持久化

- **会话事件（SessionEvent）** — 追加进日志、经 `session/event` 广播的持久事实（`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 等）。
- **会话日志** — 追加式事件流，模型所见上下文的唯一来源；fork、resume、转录、遥测、持久化都派生自它。
- **模型可见 ⟺ 已记录** — 到达模型请求的内容必须能从日志重建，运行时不变量断言；新增模型可见输入必须新增会话事件。
- **`deriveMessages()`** — 从会话日志投影模型历史的方法；原始 `assistant/chunk` 事件另保留用于重放与 UI 保真。
- **fork（分叉）** — `ctx.sessions.fork(source, boundary?, childSessionId?)` 从既有会话（可选边界点）派生子会话。
- **projection（投影单元）** — 按状态驱动的日志折叠单元（如 todo、标题）；投影缓存以"缓存行 + 持久化尾部重放"的冷读梯避免列表加载全量日志。
- **SESSION_FORMAT_VERSION / SCHEMA_VERSION** — 会话日志格式版本（当前 0，无兼容承诺）与 SQLite 单调 schema 版本；后端拒绝旧盘上格式。

## 能力接缝（capability seam）

- **接缝** — 可替换能力，含三角色：**Service Definition**（声明接口、拥有 `ctx.<key>`）、**Service Provider**（实现）、**Consumer**（消费，常见为模型可见工具）。接缝是完整能力，绝非单角色；`packages/shell` 是典型：`dsh-shell`（定义）、`dsh-bash-local` / `dsh-bash-sandbox`（provider）、`dsh-tool-bash`（consumer）。
- **请求/规范拆分（request/spec split）** — 显式优于隐式的模板：缺省解析是 owning 实现里显式的 `resolve(request): Spec` 步骤，不是 `run()` 内隐藏缺省。

## agent scope（代理作用域）

- **scope** — 每 agent 注册的单位：贡献（工具、prompt 分节、变量、限制、监听器）要么全局（所有 agent 可见）要么 scoped（恰好属于一个 scope key）。两层扁平，不向下继承。
- **scope key** — scope 的不透明身份，按对象同一性比较；约定存活 agent 即其自身 scope 的 key。
- **agent context（`agent.ctx`）** — agent 的 scoped 上下文；经它注册既 scope 可见又 scope 生命周期，其上的监听器参与该 agent 的过滤派发。
- **shadowing（遮蔽）** — 最具体者胜的名字解析：scoped 工具/分节/变量在该 scope 内替换同名全局件。这是每 agent 人设与工具变体的机制。
- **restriction（限制）** — `tools.restrict` 为一个 scope 过滤全局工具集（按交集复合）；被滤掉的工具在 prompt 与执行中都等同于不存在。
- **setup window（设置窗口）** — `CreateAgentOptions.setup` 创建槽：scope 与 agent 对象已建、agent/会话尚未发布、首 prompt 未组装。setup 只注册，从不驱动 agent。
- **lineage（血统）** — 以数据携带的父子事实（`parentSession`、持久 `delegationDepth`、运行时 `subagentDepth`）；不影响可见性。

## goal（同会话目标）

- **goal** — 附着于既有会话的一个持久完成目标，带版本化 `active` / `paused` / `blocked` / `complete` 相位与 goal-round 上限。goal 是状态而非调度器；会话日志仍是事实源。
- **goal round** — 为当前目标接纳的一个续跑循环；同会话中无关的人类 turn 不消耗 goal-round 上限。
- **goal activation（目标激活）** — 续跑 consumer 采纳下一个 goal round 的进程内许可（armed/disarmed）；刻意不进持久重放，resume/fork 后需经 `/goal` 或模型工具再次人类授权。

## Ralph（全新 agent 工作流）

- **Ralph loop** — 面向不可变目标的一次前台全新 agent 工作流运行；由 workflow 与 subagent 原语组成的模型可见工具策略，不是同会话 goal、不是循环模式、不是调度器。
- **Ralph round** — Ralph loop 中一个全新的子会话；子会话不带父会话或前轮会话种子，跨轮状态由共享工作区与 Ralph handoff 携带。
- **Ralph handoff** — 轮间传递的有界规范化结构化报告（状态、摘要、证据、后续步骤、阻塞），补充而非替代共享工作区的权威性。

## 人机交互

- **human command（人类命令）** — 斜杠前缀、由 UI 适配器经 `ctx.commands` 解释执行的指令，不成为模型消息；区别于模型可见工具与 shell 命令执行。
- **command plane（命令面）** — 发现、解析、派发、取消与结果渲染，由 UI 适配器与命令插件拥有；命令输出是 UI 状态，除非 handler 另行变更持久域。
- **审批** — `ctx.approval` 接缝上的一次性许可决策，经 `approval/request` 瀑布派发；无人应答（如无 ACP 桥）时**失败关闭**为 `unavailable` 即拒绝。
- **权限预设** — 面向用户的预设表（`workspace-write` / `danger-full-access`），捆绑沙箱模式与审批策略两个旋钮；切换写入一条 `permission/preset` 事件贯穿到两个旋钮事件。
- **ask-user** — `tool-ask-user` 在 provider 中立的 `ask()` promise 上暂停工具调用，由 UI 前端提供应答 provider。

## 工具与执行

- **工具管线五段** — `tools/pre-execute`（策略/钩子/沙箱）→ 单调守卫（deny 或弃权）→ `tools/execute`（超时/重试/指标，环绕派发）→ `tools/post-execute`（接受/拦截/替换/附加上下文）→ 归一化 + `finalizeContent` + `tools/result`（冻结的权威结果）。
- **Code Mode** — `ctx.codeRuntime` 接缝承载的模型写程序执行模式：保留的 `run_code` 传输与其序列化子调用都走工具管线；子调用携带父 token、记录 `tool/code-dispatch`、拒绝为绑定式。
- **spill（溢出）** — 超大工具文本由 spill 后端落盘并返回模型可见定位符与取回提示；`spill-policy` 是 `tools/post-execute` 上的决策 consumer。
- **compaction（压缩）** — `compaction-basic` 在 `agent/pre-step` 感知压力、在 `agent/request-error` 处理上下文溢出恢复：先工具结果剪枝，后摘要选择。
- **沙箱** — 进程约束接缝（bwrap / Landlock / Seatbelt 后端）：消费者交出即将 spawn 的精确 argv，后端按每调用策略包装并报告执行情况；`sandboxPolicy` 是部署缺省模式 + 工作区根的唯一归属。

## 其他高频词

- **ACP（Agent Client Protocol）** — 自动化专用的 JSON-RPC stdio 服务器，暴露全新 agent 会话；也是审批应答的一个来源。
- **SDK** — 进程外运行时 SDK：JSON-RPC 协议、TypeScript 客户端与服务器插件；Python 侧以换行分隔 JSON-RPC over stdio 驱动打包运行时。
- **Typert** — 类型图生成器/加载器/运行时注册表：Host 构建期分析类型，生成反射产物与 Host-for-Client Remote 投影；`@Remote` / `@RemoteScope` 标注业务方法。
- **Agent Note** — 决策记录（为什么、放弃了什么、必需验证），存于 `.agents/notes/`；`implemented/` 描述已交付现实，archived 为冻结历史。
- **快照测试** — 经真实可运行示例录制的无密钥 ACP/headless 回放，对预期转录输出；模型或产品用户可见行为的每次变更须同 PR 更新。
