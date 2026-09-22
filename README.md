# SuperLcm

[English](./README.en.md) · [项目介绍页](https://ygc3817922006-sketch.github.io/SuperLcm/) · [发布版本](https://github.com/ygc3817922006-sketch/SuperLcm/releases)

这是一个面向 DeepSeek Harness（DSH）的 SuperLcm 无损召回上下文插件，核心思路来自 Lossless Claw / SuperLcm Management（LCM，无损上下文管理）。

它把 **DSH 只追加的 Session Event Log（会话事件日志）作为唯一原文真源**。每次压缩摘要都会获得稳定的召回节点 ID；SQLite 只保存摘要 DAG（有向无环图）、父子关系和精确的源事件序号。模型以后可以搜索、描述和展开旧上下文，而不是把摘要冒充成原文。

> 当前版本：`0.3.0-alpha.9`。这是公开 alpha；请把 DSH 与插件版本固定在独立 profile 中验证后再用于主工作区。

## 为什么做 SuperLcm

传统压缩通常等上下文接近上限后，暂停当前请求并生成一个扁平摘要。这会让用户等待摘要完成，让活动上下文长期偏大，也容易因频繁改写开头而破坏 Prompt Cache。

SuperLcm 的目标是：

1. **异步压缩，不阻塞对话**：提前选择安全历史区间，用独立 provider/model 在后台生成摘要；当前 Agent 不等待这个任务。
2. **保持较小的活动上下文**：模型少读无关旧历史，保留更多输出余量，降低长上下文注意力稀释风险。
3. **保护缓存前缀**：system message 和已提交 checkpoint 逐字冻结，后续只压缩其后的原文。
4. **降低 token 与缓存成本**：较短请求减少每轮输入 token；稳定前缀提高 Prompt Cache 复用并减少重复 cache write。具体收益取决于模型提供方的计费规则。

## LCM 原理

SuperLcm 受 Clint Ehrlich 与 Theodore Blackman 的论文 **[LCM: Lossless Context Management](https://papers.voltropy.com/LCM)** 启发。论文使用分层摘要 DAG 管理长历史，同时为每个摘要保留通向原始消息的指针。

推荐先查看论文团队制作的 **[LCM 官方交互式动态讲解](https://www.losslesscontext.ai/)**：它用滚动动画展示传统扁平压缩、fresh tail、增量摘要、摘要聚合以及按需展开。论文另见 [arXiv:2605.04050](https://arxiv.org/abs/2605.04050)。

在 DSH 中，Event Log 是不可变原文真源；活动上下文只携带冻结前缀、摘要 checkpoint 和最近原文；SQLite 保存可重建的 DAG 与精确事件序号；召回工具在需要时回到原始事件。

## 已实现

- 原始会话只由 DSH 保存，SQLite 不复制整份 transcript（会话记录）。
- 继承 DSH 官方 `BasicCompactionEngine`，只改摘要 seam（扩展接口）与 rolling 自动触发策略。
- 为摘要加入稳定、机器可读的召回标记并形成分层摘要 DAG。
- 使用 `(session_id, node_id)` 复合身份，父会话和 fork（分叉）子会话不会互相覆盖。
- 按事件序号精确追回原始事件；单个超大事件也可连续分页，不丢中段。
- 只增量索引完整成功的压缩事务；SQLite 损坏或删除后，可从 DSH 会话事件日志显式重建。
- 提供 `lcm_grep`、`lcm_describe`、`lcm_expand`、`lcm_expand_query`、`lcm_reindex`、`lcm_doctor` 六个召回与修复工具。

## 压缩模型

压缩摘要可以使用与主 Agent 不同的模型。插件直接复用 DSH 官方 `BasicCompactionEngine` 的 `summarizationProvider` / `summarizationModel` 路由，不建立第二套路由系统。

在 WebUI → Plugin configuration → SuperLcm 中可以直接填写：

```text
压缩 Provider: openai
压缩 Model:    gpt-5.6-sol
```

自动压缩必须明确配置 provider/model 两项。留空或只填一项都会被拒绝；后台任务绝不回退到当前 Agent 或 custom-subagent 的模型。保存后对后续压缩立即生效，无需重启插件。

## 全面异步滚动压缩

SuperLcm 只支持一种自动策略：`mode: "rolling"`、`foldTiming: "background"`。阻塞式 `sync` 和旧的同步 `threshold` 模式都会被拒绝。

默认至少原样保留最近 24 个 surface node（表面节点）和 32k token。安全的 64k 原文批次可立刻交给独立 Worker 后台生成摘要，但 ready 结果先不进入 surface，直到 160k soft-cap、220k hard-cap 或 overflow 要求缩减。提交后，最前面的 system message 和此前已经提交的 checkpoint 都冻结为逐字不变的前缀；以后只压它们后面的原文。只有 hard pressure 才允许低频合并冻结摘要。准备与提交都不阻塞当前回复。

后台 Worker 先固定选区快照，使用插件配置的独立模型和独立 AbortController 生成摘要；完成后只在选区与 token-meter 快照仍稳定时提交。期间允许尾部继续增长；若选区被改写，则丢弃结果并稍后重新准备。提交仍写入标准持久事件：`compaction/start`、`compaction/summary`、替换用 `user/message`、`compaction/end`。

完整策略与 GPT-5.6 Sol 推荐起始值见 [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md)。

## 缓存优化

SuperLcm 不猜 Prompt Cache 的 TTL。提交后的 system 和 checkpoint 形成最长逐字稳定前缀；普通压缩只处理它们后面的 raw history。只有硬压力且后段已经无法释放足够空间时，才允许低频合并旧 checkpoint。

```text
SYSTEM · CHECKPOINT 01 · CHECKPOINT 02 │ RAW HISTORY │ FRESH TAIL
└──────────── 逐字冻结，可持续命中缓存 ────────────┘
```

较短的活动请求减少每轮输入 token；稳定前缀减少重复缓存写入。实际缓存命中和费用仍由所用模型提供方决定。

## 与 gbrain 的边界

`SuperLcm` 管“本次 DSH 工作线程到底发生过什么”；gbrain 管跨会话、跨项目的稳定结论、历史决策和长期知识。两边不应自动双写。只有主代理确认某个结论已经稳定，才应通过单独流程沉淀到 gbrain。

## “无损”的准确含义

无损的是原始 DSH 事件及其精确召回路径，不是摘要文本本身：

```text
摘要节点 → 精确 source event seq → DSH 原始事件
```

SQLite 是可重建的派生索引，不是第二套会话真源。删掉 SQLite 会失去索引，但不会删掉 DSH 原文；运行 `lcm_reindex` 可以从完整成功的压缩事务恢复。`lcm_doctor` 默认只读，只有显式传入 `repair: true` 才重建。

## 安装与启用

需要 Node.js 22.16 以上，并要求当前 DSH 版本仍提供：

- `@deepseek-ai/dsh-compaction-basic`
- `@deepseek-ai/dsh-compaction`
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-tools`
- `session/event` 生命周期

### 跨平台路径

运行时代码不包含 macOS 或 `/Users/...` 硬编码。数据库路径按当前操作系统解析：优先使用 `DSH_SUPERLCM_DB`，其次使用 `DSH_HOME/SuperLcm/lcm.sqlite`，最后使用系统用户目录下的 `.dsh/SuperLcm/lcm.sqlite`。路径由 Node.js `node:path` 与 `node:os.homedir()` 处理。CI 覆盖 Windows、Linux、macOS 的 Node.js 22，并在 Linux 上额外覆盖 Node.js 24。

### 从公开 Release 安装

Web profile：

```text
dsh plugin --profile web add "https://github.com/ygc3817922006-sketch/SuperLcm/releases/download/v0.3.0-alpha.9/SuperLcm-0.3.0-alpha.9.tgz"
```

ACP profile：

```text
dsh plugin --profile acp add "https://github.com/ygc3817922006-sketch/SuperLcm/releases/download/v0.3.0-alpha.9/SuperLcm-0.3.0-alpha.9.tgz"
```

不要在正式 DSH profile 目录中手工执行未经检查的 `pnpm add`，以免额外安装一份 DSH 核心包。使用 `dsh plugin --profile ... add` 让 DSH 管理 profile 依赖。

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

自动测试覆盖无损召回合同、rolling 选区、soft/hard 非阻塞处理、独立取消信号、分阶段事务稳定性、同步模式拒绝，以及独立压缩模型设置校验与热更新。当前测试仍不等于正式 DSH 桌面端全链路证书；alpha 版在正式 profile 启用前必须跑真实 Agent loop（代理循环）验收。

## 架构

见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 与 [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md)。

## 许可证与署名

MIT。详见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

SuperLcm 是独立项目，不隶属于 Voltropy、Martian Engineering 或 DeepSeek；仓库没有复制 LCM、Lossless Claw 或 DSH 的源文件。
