# Security policy / 安全策略

## Supported versions / 支持版本

SuperLcm is currently a public alpha. Security fixes are applied to the newest alpha only. / SuperLcm 当前处于公开 alpha 阶段，安全修复只进入最新 alpha。

## Reporting / 报告方式

Please do not publish credentials, private session events, database files, or an exploitable vulnerability in a public issue. Use the repository's **Security → Report a vulnerability** flow to open a private GitHub Security Advisory. / 请勿在公开 Issue 中粘贴凭据、私人会话事件、数据库文件或可利用漏洞；请通过仓库的 **Security → Report a vulnerability** 私密报告。

A useful report includes the DSH version, SuperLcm version, operating system, minimal configuration, reproduction steps, and sanitized logs. / 报告请包含 DSH 版本、SuperLcm 版本、操作系统、最小配置、复现步骤和脱敏日志。

## Data boundary / 数据边界

SuperLcm treats the DSH append-only event log as canonical raw history. Its SQLite database is a rebuildable derived index. Never attach either source logs or SQLite files to a public issue without redaction. / DSH 只追加事件日志是原文真源；SQLite 是可重建派生索引。未经脱敏，不要把任何一者上传到公开 Issue。
