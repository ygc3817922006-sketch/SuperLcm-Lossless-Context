# 全面异步持久上下文策略 / Fully asynchronous persistent context policy

本文定义 SuperLcm 的 rolling 策略。目标是在不阻塞当前 Agent 的前提下，让长生命周期会话维持可用上下文，并保留可精确召回的原始事件。

## GPT-5.6 Sol 起始配置

```yaml
mode: rolling
tailCount: 24
minRetainTokens: 32000
pressureFoldTokens: 20000
foldBatchTokens: 64000
softActiveTokens: 160000
hardActiveTokens: 220000
foldTiming: background
summarizationProvider: openai
summarizationModel: gpt-5.6-sol
# 可选备用路由 / Optional backup route
fallbackSummarizationProvider: anthropic
fallbackSummarizationModel: claude-sonnet-4-5
```

这些是长上下文 Worker 的起始值，不是通用常量。较小上下文模型应按比例降低门槛。

自动压缩必须显式配置独立的主 provider/model。备用 provider/model 可留空；配置时必须成对填写，且不能与主路由相同。主路由失败后，SuperLcm 仅在任务未取消时用备用路由重试一次；备用也失败时报告两次错误并停止。整个过程都不会回退到当前 Agent 或 custom-subagent 路由。

## 选区规则

- `tailCount=24`：正常滚动时至少原样保留最近 24 个 surface node。
- `minRetainTokens=32000`：独立的近期 token 下限，避免大量短消息留下过小工作集。
- `foldBatchTokens=64000`：旧原文达到该规模即可后台准备摘要；摘要保持 ready，不立即改 active prefix。
- `pressureFoldTokens=20000`：活动上下文达到 160k soft cap 后允许的最小有效缩减。
- `hardActiveTokens=220000`：达到 hard cap 后接纳任何配对完整的非空缩减。此时节点数偏好可放宽到一个近期节点，但 32k token 下限与工具调用配对边界不放宽。

每次 pre-step 按以下优先级选择一个安全 head：

1. `hard-cap`：活动 token 达到 hard cap；
2. `soft-cap`：达到 soft cap，且 head 至少有 `pressureFoldTokens`；
3. `background-batch`：head 至少有 `foldBatchTokens`，允许立即后台准备；
4. 否则不启动。

三个原因只影响选区准入，执行方式完全相同：全部后台、全部非阻塞、每个 Agent 同时最多一个 Worker。

## 后台事务

1. **Stage**：同步读取当前 surface、消息、token-meter 节点和工具配对边界，生成稳定快照。该步骤不调用模型。
2. **Summarize**：后台先使用插件配置的主专用路由生成摘要；主路由失败时可用显式备用路由重试一次。每次调用固定自己的路由快照，不修改共享 engine config。任务拥有独立 `AbortController`，当前 turn 的取消不会取消它；一旦该后台任务自身被取消，就不会启动备用请求。
3. **Commit**：常规 ready 批次等到 soft/hard pressure 才提交，overflow 可强制提交；不再猜测 provider 的缓存过期时间。只有原选区序列、对应 token 节点、replace generation 与工具配对仍一致时才提交；尾部新增消息不影响提交。
4. **Restage**：选区已变时丢弃摘要，不写任何压缩事件，稍后重新选区。

成功提交连续写入 `compaction/start`、`compaction/summary`、带 surface replace 的 `user/message`、`compaction/end`。原始事件不会删除，summary 继续携带精确 source seq 与 SuperLcm DAG marker。

## 溢出行为

Context overflow handler 只提交已经完成的后台摘要；若摘要仍在生成，它会保留原始 overflow 错误并立即返回，不会等待模型。正常情况下 64k 批次会在 soft/hard cap 之前提前启动，从而避免走到这个兜底。

## Cache 与 PTC

缓存策略不再依赖 TTL 猜测。第一次提交后，system message 与已提交 checkpoint 组成冻结前缀；后续摘要只替换冻结前缀之后的原文，因此每次变化点持续向后移动。常规摘要在后台提前准备，到 soft/hard pressure 才进入 surface；只有 hard pressure 且冻结前缀本身妨碍缩减时，才允许合并旧 checkpoint 并付出一次前缀失效。

Programmatic Tool Calling (PTC) 仍应在源头过滤、聚合机械工具输出。SuperLcm 保存真正有用的历史和精确召回路径，而不是反复总结可丢弃的扫描噪声。
