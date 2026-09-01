# Changelog

## 0.2.0-alpha.2 — 2026-09-01

- Fix a constructor-timing crash that broke webui startup in a launchd restart
  loop: the DSH base constructor invokes the automatic-compaction hook during
  `super()`, before the subclass `rollingConfig` field is assigned, so reading
  `rollingConfig.mode` threw `TypeError`. Registration is now deferred to a
  microtask that fires after construction; semantics are unchanged.
- The test-harness stub base now mirrors the real DSH timing (hook invoked
  during `super()`) and a regression test covers the deferral.

## 0.2.0-alpha.1 — 2026-09-01

- New `mode: "rolling"` compaction policy (default): lossless-claw style
  steady-state maintenance. Every agent step keeps a fresh verbatim tail of
  `tailCount` surface nodes and folds the older head into the running summary
  once it exceeds `foldBatchTokens`, so the active surface stays inside its
  budget instead of growing until a one-shot threshold fires.
- Repeated rolling folds chain summary markers into the multi-level recall DAG
  automatically; `lcm_describe` now reports the computed `level` of each node.
- `mode: "threshold"` preserves the 0.1.x behavior verbatim (official
  thresholdRatio/retainRatio pressure compaction).
- Context-overflow recovery (fold on provider context-window errors, then
  retry the request) is preserved in both modes.
- Selection reuses the official tool-pairing balance guard, so a rolling fold
  never splits a tool call/result pair.

## 0.1.0-alpha.1 — 2026-08-31

- First DSH-native lossless-context alpha.
- DSH session log retained as the sole raw-history authority.
- Hierarchical checkpoint markers and SQLite summary DAG.
- Six recall, expansion, repair and health tools.
- Exact pagination through oversized individual events.
- Fork-safe `(session_id, node_id)` storage.
- Safe bundle mounts tools only; compaction replacement is explicit per Agent preset.
