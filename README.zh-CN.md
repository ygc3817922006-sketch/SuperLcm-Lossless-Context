# dsh-lossless-context

这是一个面向 DeepSeek Harness（DSH）的无损召回上下文插件，核心思路来自 Lossless Claw / Lossless Context Management（LCM，无损上下文管理）。

它把 **DSH 只追加的 Session Event Log（会话事件日志）作为唯一原文真源**。每次压缩摘要都会获得稳定的召回节点 ID；SQLite 只保存摘要 DAG（有向无环图）、父子关系和精确的源事件序号。模型以后可以搜索、描述和展开旧上下文，而不是把摘要冒充成原文。

> 当前版本：`0.2.0-alpha.1`。lossless-claw 式的滚动稳态压缩（见下文「压缩模式」）已实现；后台延迟压缩、跨会话归并、向量检索和正式桌面端全链路验收仍未完成。

## 已实现

- 原始会话只由 DSH 保存，SQLite 不复制整份 transcript（会话记录）。
- 继承 DSH 官方 `BasicCompactionEngine`，只改写受保护的摘要接口。
- 为摘要加入稳定、机器可读的召回标记。
- 从被压缩区域中识别旧摘要节点，逐级形成摘要 DAG。
- 使用 `(session_id, node_id)` 复合身份，父会话和 fork（分叉）子会话不会互相覆盖。
- 按事件序号精确追回原始事件。
- 单个超大事件也能通过 `source_offset + event_char_offset` 连续分页，不丢中段。
- SQLite 损坏或删除后，可从 DSH 会话事件日志重新建索引。
- 提供六个工具：
  - `lcm_grep`：搜摘要和/或原始事件。
  - `lcm_describe`：查看节点、父子关系、源事件范围和模型信息。
  - `lcm_expand`：精确展开一个节点引用的原始事件。
  - `lcm_expand_query`：先搜摘要，再展开命中的原始事件。
  - `lcm_reindex`：增量刷新或完整重建索引。
  - `lcm_doctor`：检查 SQLite、重复节点、坏指针和缺失子节点。

## 压缩模式

压缩 provider 通过 `mode` 提供两种触发策略:

- `mode: "rolling"`(0.2.0 起默认)——lossless-claw 式的稳态维护。每个 agent step 保留最近 `tailCount` 个表面节点逐字不动,更早的头部一旦超过 `foldBatchTokens` 就折叠进运行摘要。活跃表面始终贴近预算,不再等到一次性阈值才触发;反复折叠会把摘要标记串成多级召回 DAG(`lcm_describe` 会报告节点 `level`)。
- `mode: "threshold"`——官方 `BasicCompactionEngine` 的一次性行为:用量超过路由模型窗口的 `thresholdRatio` 时触发,保留 `retainRatio`/`retainTokens` 逐字不动。

两种模式都保留官方的上下文溢出恢复(供应商报窗口超限时先压缩再重试请求),并复用官方事务化 `compactRegion`(含压缩锁、回放校验和工具配对平衡保护)。

## 与 gbrain 的边界

`dsh-lossless-context` 管“本次 DSH 工作线程到底发生过什么”；gbrain 管跨会话、跨项目的稳定结论、历史决策和长期知识。两边不应自动双写。

只有主代理确认某个结论已经稳定，才应通过单独流程沉淀到 gbrain。LCM 的中间摘要不直接写 gbrain，否则会把临时推理和压缩误差变成长期事实。

## “无损”的准确含义

无损的是原始 DSH 事件及其精确召回路径，不是摘要文本本身。摘要仍可能遗漏或概括错误，因此插件明确保留：

```text
摘要节点 → 精确 source event seq → DSH 原始事件
```

SQLite 是可重建的派生索引，不是第二套会话真源。删掉 SQLite 会失去索引，但不会删掉 DSH 原文；运行 `lcm_reindex` 可以恢复。

## 安装与启用

需要 Node.js 22.16 以上，并要求当前 DSH 版本仍提供：

- `@deepseek-ai/dsh-compaction-basic`
- `@deepseek-ai/dsh-tools`
- `session/event` 生命周期

先在独立开发 profile（配置环境）中打包：

```bash
npm run validate
npm pack
```

不要在正式 DSH profile 目录中不加检查地执行 `pnpm add`，以免额外安装一份 `dsh-tools`、`dsh-agent-loop`、Cordis 等核心包。DSH 的部分运行时能力依赖共享 Symbol（符号）；同一核心包出现两份实例，可能造成“代码一样但运行时身份不同”。

### 第一阶段：只挂召回工具

仓库自带的 `cordis.patch.yml` 默认只加载：

```yaml
- insert:
    - id: dsh-lossless-context-tools
      name: dsh-lossless-context/tool
```

它不会偷偷再挂一套压缩引擎，因此适合先验证工具注册、数据库路径和回放能力。

### 第二阶段：替换正式压缩提供方

同一个隔离 Agent 上只能保留一套 `ctx.compaction`。应在现有 compaction 节点上把插件名替换为：

```yaml
name: dsh-lossless-context
```

不能把它和 `dsh-compaction-basic` 并排追加。现有节点 ID、隔离层级和已验证配置应尽量保持不变。示意见 [`examples/enable-compaction.patch.yml`](./examples/enable-compaction.patch.yml)。

开发期先保持 disabled（禁用）或使用独立 profile；通过静态检查、单测和一次性真实会话验收后再打开。验收顺序见 [`docs/VALIDATION.md`](./docs/VALIDATION.md)。

## 数据库

默认路径：

```text
~/.dsh/lossless-context/lcm.sqlite
```

可以覆盖：

```bash
export DSH_HOME=/custom/dsh/home
export DSH_LOSSLESS_DB=/absolute/path/lcm.sqlite
```

数据库启用 WAL（预写日志），保存摘要节点、DAG 边、源事件序号、模型/提供方信息和全文索引，不保存整份原始事件正文。

## 开发验收

```bash
npm run validate
npm pack --dry-run
```

测试覆盖：标记编解码、DAG 重建、中英文检索、SQLite 事务、父子会话隔离、稀疏事件序号、单个超大事件连续分页、工具注册、插件卸载关闭数据库，以及索引失败不打断 DSH 主链。

当前测试是代码合同测试，不等于正式 DSH 桌面端全链路证书。alpha 版在正式 profile 启用前必须跑真实 Agent loop（代理循环）验收。

## 架构

见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。
