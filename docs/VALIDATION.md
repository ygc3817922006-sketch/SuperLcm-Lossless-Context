# Validation contract

## Automated checks

Run from the repository root:

```bash
npm run validate
npm pack --dry-run
```

`npm run validate` performs syntax/package checks and the Node test suite. The test runner creates temporary peer stubs only when no `node_modules` directory exists and removes them afterward. It refuses to replace a real dependency tree.

The current suite verifies:

- versioned marker round trips and corruption rejection;
- cyclic/nested content traversal safety;
- human summary text does not contain marker metadata;
- committed compaction events become reconstructable nodes;
- parent/child summary DAG reconstruction;
- exact source sequence preservation;
- expansion through a single very large event without middle truncation;
- sparse or reordered event arrays resolved by `event.seq`;
- raw-event and summary search scopes;
- Unicode substring fallback for Chinese queries;
- transactional edge/FTS replacement;
- `(session_id, node_id)` fork isolation;
- doctor and rebuild behavior;
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
4. Call `lcm_doctor` and confirm SQLite opens at the intended path.
5. Replace, rather than append, the existing compaction provider with `dsh-lossless-context`.
6. Generate enough harmless context to trigger one real DSH compaction.
7. Inspect the committed `compaction/summary` event and confirm it contains one `dsh-lcm:v1` marker.
8. Run `lcm_reindex` and confirm one node is indexed.
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

`0.1.0-alpha.1` has an automated source-level test certificate only. A real DSH desktop/profile Agent-loop certificate must be produced on the target installation and pinned to its DSH version and profile manifest.
