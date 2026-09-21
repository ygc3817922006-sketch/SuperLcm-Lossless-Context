# SuperLcm

这是一个面向 DeepSeek Harness（DSH）的 SuperLcm 无损召回上下文插件，核心思路来自 Lossless Claw / SuperLcm Management（LCM，无损上下文管理）。

它把 **DSH 只追加的 Session Event Log（会话事件日志）作为唯一原文真源**。每次压缩摘要都会获得稳定的召回节点 ID；SQLite 只保存摘要 DAG（有向无环图）、父子关系和精确的源事件序号。模型以后可以搜索、描述和展开旧上下文，而不是把摘要冒充成原文。

> 当前版本：`0.3.0-alpha.1`。rolling（滚动）压缩使用 cache-aware（缓存感知）策略；压缩摘要模型现在可以独立指定，并可在 WebUI 的插件设置页热更新。原始历史仍由 DSH Event Log 无损保留。

## 已实现

- 原始会话只由 DSH 保存，SQLite 不复制整份 transcript（会话记录）。
- 继承 DSH 官方 `BasicCompactionEngine`，只改摘要 seam（扩展接口）与 rolling 自动触发策略。
- 为摘要加入稳定、机器可读的召回标记并形成分层摘要 DAG。
- 使用 `(session_id, node_id)` 复合身份，父会话和 fork（分叉）子会话不会互相覆盖。
- 按事件序号精确追回原始事件；单个超大事件也可连续分页，不丢中段。
- SQLite 损坏或删除后，可从 DSH 会话事件日志重新建索引。
- 提供 `lcm_grep`、`lcm_describe`、`lcm_expand`、`lcm_expand_query`、`lcm_reindex`、`lcm_doctor` 六个召回与修复工具。

## 压缩模型

压缩摘要可以使用与主 Agent 不同的模型。插件直接复用 DSH 官方 `BasicCompactionEngine` 的 `summarizationProvider` / `summarizationModel` 路由，不建立第二套路由系统。

在 WebUI → Plugin configuration → SuperLcm 中可以直接填写：

```text
压缩 Provider: openai
压缩 Model:    gpt-5.6-sol
```

两项都留空时，压缩摘要跟随当前 Agent 的实际路由模型；要指定独立压缩模型时必须两项同时填写。字段接受任意当前 DSH adapter 可路由的真实 provider/model ID，插件不会写死模型名单。保存后对后续 compaction 立即生效，不需要重启插件。

DSH 当前的 Web 模型目录是 session-scoped（按会话作用域）的，因此本插件没有把当前聊天会话的 ModelSelect 组件硬绑定到全局压缩配置。等 DSH 提供全局 model catalog 后，可在不改变底层配置合同的前提下把这两个自由文本框升级为联动下拉菜单。

## 压缩模式

压缩 provider（提供方）通过 `mode` 提供两种触发策略：

- `mode: "rolling"`（默认）——面向持久 Worker（工作子代理）的缓存感知维护。默认至少保留最近 24 个 surface node（表面节点）和 32k token 原文；普通前缀改写等待至少 64k 的旧 head，并尽量等缓存变冷。活动上下文达到 160k 后，只要能安全折叠至少 20k 就触发 soft-cap（软门）；达到 220k 后进入 hard-cap（硬门），任何安全且有意义的旧 head 都可以折叠。即使 `foldTiming=background`，soft/hard 压力折叠也会同步完成后才允许下一次模型请求。
- `mode: "threshold"`——官方 `BasicCompactionEngine` 的一次性行为：用量超过路由模型窗口的 `thresholdRatio` 时触发，并按 `retainRatio`/`retainTokens` 保留近期原文。

缓存启发式由 `cacheTtlSeconds` 控制，默认 1800 秒。插件加载后第一次观察到的模型 step（步骤）保守视为缓存仍热；之后连续 step 的间隔小于该 TTL 时，普通 rolling 改写会延迟。设置为 `0` 可关闭缓存延迟。

两种模式都保留 DSH 官方的 context-overflow recovery（上下文溢出恢复），并复用官方事务化 `compactRegion`，包括 compaction lock（压缩锁）、replay validation（回放校验）、shrink check（缩减检查）和工具调用配对保护。

完整策略、GPT-5.6 Sol 推荐起始值、后台折叠的稳定性限制，以及为什么当前版本没有假装实现“20k leaf（叶摘要）+64k commit（表面提交）”，见 [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md)。

## 与 gbrain 的边界

`SuperLcm` 管“本次 DSH 工作线程到底发生过什么”；gbrain 管跨会话、跨项目的稳定结论、历史决策和长期知识。两边不应自动双写。只有主代理确认某个结论已经稳定，才应通过单独流程沉淀到 gbrain。

## “无损”的准确含义

无损的是原始 DSH 事件及其精确召回路径，不是摘要文本本身：

```text
摘要节点 → 精确 source event seq → DSH 原始事件
```

SQLite 是可重建的派生索引，不是第二套会话真源。删掉 SQLite 会失去索引，但不会删掉 DSH 原文；运行 `lcm_reindex` 可以恢复。

## 安装与启用

需要 Node.js 22.16 以上，并要求当前 DSH 版本仍提供：

- `@deepseek-ai/dsh-compaction-basic`
- `@deepseek-ai/dsh-compaction`
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-tools`
- `session/event` 生命周期

先在独立开发 profile（配置环境）中打包：

```bash
npm run validate
npm pack
```

不要在正式 DSH profile 目录中不加检查地执行 `pnpm add`，以免额外安装一份 DSH 核心包。DSH 的部分运行时能力依赖共享 Symbol（符号）；同一核心包出现两份实例，可能造成“代码一样但运行时身份不同”。

### 第一阶段：只挂召回工具

```yaml
- insert:
    - id: SuperLcm-tools
      name: SuperLcm/tool
```

### 第二阶段：替换正式压缩提供方

同一个隔离 Agent 上只能保留一套 `ctx.compaction`。应在现有 compaction 节点上把插件名替换为：

```yaml
name: SuperLcm
```

不能把它和 `dsh-compaction-basic` 并排追加。现有节点 ID、隔离层级和已验证的基础配置应尽量保持不变。GPT-5.6 Sol 的持久 Worker 推荐参数见 [`examples/enable-compaction.patch.yml`](./examples/enable-compaction.patch.yml)。

## 默认持久 Worker 参数

```yaml
mode: rolling
summarizationProvider: ""
summarizationModel: ""
tailCount: 24
minRetainTokens: 32000
pressureFoldTokens: 20000
foldBatchTokens: 64000
softActiveTokens: 160000
hardActiveTokens: 220000
cacheTtlSeconds: 1800
foldTiming: background
```

其中 160k/220k 是面向 GPT-5.6 Sol 的起始值，不应不加判断地复制给小上下文模型。`activeTokens` 使用 DSH canonical token meter（规范令牌计量器）的整份真实请求估算，不只是消息正文。

## 数据库

默认路径：

```text
~/.dsh/SuperLcm/lcm.sqlite
```

数据库启用 WAL（预写日志），保存摘要节点、DAG 边、源事件序号、模型/提供方信息和全文索引，不保存整份原始事件正文。

## 开发验收

```bash
npm run validate
npm pack --dry-run
```

自动测试覆盖原有无损召回合同、缓存感知 rolling、soft/hard 压力覆盖、background/sync（后台/同步）触发语义，以及压缩模型设置的配对校验与热更新。当前测试仍不等于正式 DSH 桌面端全链路证书；alpha 版在正式 profile 启用前必须跑真实 Agent loop（代理循环）验收。

## 架构

见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 与 [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md)。