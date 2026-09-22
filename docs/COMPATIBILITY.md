# 兼容性 / Compatibility

[中文](#中文) · [English](#english)

## 中文

### 平台设计

SuperLcm 运行时只使用 Node.js 跨平台 API：`node:path`、`node:os`、`node:fs` 与 `node:sqlite`。源码不包含 macOS 的 `/Users/...`、Linux 的固定 home 路径或 Windows 盘符。

数据库位置按以下优先级解析：

1. `DSH_SUPERLCM_DB`；
2. `DSH_HOME/SuperLcm/lcm.sqlite`；
3. 操作系统用户目录下的 `.dsh/SuperLcm/lcm.sqlite`。

### 验证范围

| 范围 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Node.js 22 单元/合同测试 | GitHub Actions | GitHub Actions | GitHub Actions |
| Node.js 24 单元/合同测试 | — | GitHub Actions | — |
| 真实 DSH Web/ACP 安装与启动 | 尚未认证 | 尚未认证 | DSH 10.28.2 已验证 |

“CI 通过”只证明源码和派生 SQLite 行为跨平台，不等于对应平台上的完整 DSH 桌面/服务运行时已经生产认证。欢迎 Windows/Linux 用户按 [VALIDATION.md](./VALIDATION.md) 提交真实运行证据。

### 最低要求

- Node.js 22.16.0+（需要 `node:sqlite`）。
- DSH 提供官方 compaction、LLM、tools 与 `session/event` 接口。
- 自动压缩配置独立的摘要 provider/model。

## English

### Platform design

SuperLcm runtime code uses portable Node.js APIs only: `node:path`, `node:os`, `node:fs`, and `node:sqlite`. It contains no macOS `/Users/...` path, fixed Linux home, or Windows drive assumption.

The database path resolves in this order:

1. `DSH_SUPERLCM_DB`;
2. `DSH_HOME/SuperLcm/lcm.sqlite`;
3. `.dsh/SuperLcm/lcm.sqlite` under the platform user home.

### Validation scope

| Scope | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Node.js 22 unit/contract tests | GitHub Actions | GitHub Actions | GitHub Actions |
| Node.js 24 unit/contract tests | — | GitHub Actions | — |
| Real DSH Web/ACP install and startup | Not certified yet | Not certified yet | Verified on DSH 10.28.2 |

A green CI run proves portable source and derived SQLite behavior; it is not a production certificate for the complete DSH desktop/service runtime on that OS. Windows and Linux users are invited to submit real-runtime evidence following [VALIDATION.md](./VALIDATION.md).

### Minimum requirements

- Node.js 22.16.0+ (`node:sqlite` is required).
- A DSH build exposing the official compaction, LLM, tools, and `session/event` interfaces.
- An explicit detached summarizer provider/model for automatic compaction.
