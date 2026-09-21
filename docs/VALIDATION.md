# 验收合同 / Validation contract

## Automated checks

Run from the repository root:

```bash
npm run validate
npm pack --dry-run
```

`npm run validate` performs syntax/package checks and the Node test suite. The test runner supplies peer stubs through an in-memory ESM loader. It never creates, replaces, or deletes `node_modules`.

The current suite verifies:

- versioned marker round trips and corruption rejection;
- cyclic/nested content traversal safety;
- human summary text does not contain marker metadata;
- only complete successful start/summary/checkpoint/end lifecycles become reconstructable nodes;
- incomplete, failed, and mismatched lifecycles are ignored;
- incremental replay advances through ordinary tail events without skipping a lifecycle that completes across calls;
- parent/child summary DAG reconstruction accepts children only from trusted checkpoint-source events;
- exact source sequence preservation;
- expansion through a single very large event without middle truncation;
- sparse or reordered event arrays resolved by `event.seq`;
- raw-event and summary search scopes;
- Unicode substring fallback for Chinese queries;
- transactional edge/FTS replacement;
- `(session_id, node_id)` fork isolation;
- read-only doctor behavior and explicit repair/rebuild;
- shared `max_chars` enforcement across multi-node expansion;
- cycle-safe DAG levels with shared descendants;
- complete six-tool registration;
- tools are bound to the calling live agent session;
- lifecycle disposal closes SQLite;
- post-commit index failures do not break the session event path;
- the bundled patch never auto-mounts a second compaction provider.

## Real DSH profile gate

Automated contract tests are necessary but not sufficient. Before enabling the compaction provider in a primary profile, use a disposable isolated profile and pass all of these checks:

1. Confirm only one physical copy of DSH core/runtime packages is resolved in the profile.
2. Load the tools-only bundle with the engine disabled.
3. Open a disposable session and confirm all six tools are visible.
4. Call `lcm_doctor` with `repair: false`; confirm it reports without mutating SQLite. Use `repair: true` only when a rebuild is intended.
5. 替换而不是追加现有压缩提供方为 `SuperLcm`。
Replace, rather than append, the existing compaction provider with `SuperLcm`.
6. Generate enough harmless context to trigger one real DSH compaction.
7. Inspect the full committed lifecycle (`start`, marker-bearing `summary`, checkpoint replacement, successful `end`).
8. Run `lcm_reindex` and confirm one node is indexed; append ordinary events, rerun twice, and confirm the second rerun scans zero events past the recorded scan cursor.
9. Use `lcm_grep` to find a phrase that existed only before compaction.
10. Use `lcm_expand` until `next` is null and byte-compare the recovered serialized event with the canonical session event.
11. Trigger a second compaction that contains the first checkpoint and confirm a parent-to-child edge appears.
12. Fork the session, produce a fork-specific compaction, and verify parent/fork descriptions stay isolated.
13. Restart the profile, rerun `lcm_doctor`, and confirm the index survives.
14. Stop DSH cleanly and confirm WAL files settle without integrity errors.

## Hard failures

Do not enable the plugin in the primary profile if any of these occur:

- two active `ctx.compaction` providers;
- duplicate copies of DSH core packages in one runtime;
- a committed summary lacks a marker;
- source event sequences cannot be resolved exactly;
- `lcm_expand` skips a section of a large event;
- a fork overwrites the parent namespace;
- SQLite failure interrupts the DSH session transaction;
- restart changes or loses the canonical DSH session log;
- the plugin edits/deletes raw historical events.

## Current certificate boundary

`0.3.0-alpha.8` has an automated source-level certificate; the profile certificate remains the real runtime gate.
`0.3.0-alpha.8` 有源码级自动测试证书；profile 证书仍以真实运行时验收为准。 A real DSH desktop/profile Agent-loop certificate must be produced on the target installation and pinned to its DSH version and profile manifest.
