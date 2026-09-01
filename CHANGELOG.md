# Changelog

## 0.2.0-alpha.6 — 2026-09-01

- Rolling mode is now cache-aware instead of rewriting the active prefix for
  every small batch. The persistent-worker defaults keep 24 recent surface
  nodes plus at least 32k recent tokens verbatim, use a 64k routine commit
  batch, and defer routine mutation while the provider cache is likely hot.
- New pressure boundaries: `softActiveTokens=160000` admits a useful fold once
  at least `pressureFoldTokens=20000` can be removed; `hardActiveTokens=220000`
  forces any balanced useful reduction. Under the hard cap only, the 24-node
  tail preference may relax to one recent node while the 32k token floor and
  tool-pairing guard remain intact.
- New `cacheTtlSeconds` heuristic (default 1800): the first observed step is
  conservatively treated as cache-hot; later inter-step gaps inside the TTL
  defer routine prefix mutation. `0` disables cache deferral.
- `foldTiming: "background"` is now limited to opportunistic `cold-batch`
  folds. Soft/hard pressure folds are synchronous even in background mode so
  the active-context caps are guaranteed to land before the next model
  request. Background folds remain fail-closed if DSH's whole-surface
  stability check observes a concurrent append.
- Rolling logs include the admission reason, active token estimate, retained
  tail estimate, and hot/cold cache heuristic.
- Added `docs/CACHE_POLICY.md` and an explicit GPT-5.6 Sol persistent-worker
  example. This alpha deliberately does not fake detached 20k leaf summaries;
  DSH currently exposes one summarizer transaction per `compactRegion()`.
- Declare the directly imported `@deepseek-ai/dsh-compaction` and
  `@deepseek-ai/dsh-llm` packages as optional peers, matching the existing
  duplicate-core avoidance policy.

## 0.2.0-alpha.5 — 2026-09-01

- Fix a browser load crash ("exports is not defined" → "Failed to load
  plugins"): the module-loader convention is for the `factory(require)` body
  to build its own CJS export object, and the packaged bundle omitted the
  declarations. The factory now opens with `var module = { exports: {} };
  var exports = module.exports;` (plus a `Symbol.toStringTag` Module tag) so
  the trailing `exports.*` assignments and `return module.exports` resolve.
  Merged back from the hot-patched profile copy after alpha.4 took the webui
  down at first load.

## 0.2.0-alpha.4 — 2026-09-01

- Web settings page: the plugin now appears as a card under Plugin
  configuration (Plugin configuration) with the rolling-compaction
  tunables — tail message count, fold batch tokens, fold timing, compaction
  threshold and retention ratio — editable with Save/Discard staging.
  Host side, the engine registers a `lossless-context` settings section via
  `settings.installSection`; changes apply live to `rollingConfig`, and the
  threshold/retention ratios are spread-replaced onto the frozen base config
  (a token-based retention form is dropped so the ratio takes effect). A
  validate hook rejects `retainRatio >= thresholdRatio` both on the host and
  in the card.
- `mode` is intentionally not exposed on the card: switching it requires
  re-registering the pressure hooks, so it stays host-config-only and applies
  on plugin reload.
- New `./client` browser bundle (plain React.createElement, no build tooling)
  with `dsh.client` web-platform metadata; runtime injects are the locale and
  settings-scope services only — UI primitives are not imported so the
  client-plugin purity gate holds.

## 0.2.0-alpha.3 — 2026-09-01

- New rolling option `foldTiming: "background"` (default): lossless-claw style
  asynchronous folding. The pre-step hook no longer blocks the agent step on a
  fold — a pending fold from the previous step is settled first (so two
  summarizer calls never race for the session's single compaction lock), then
  the new pass runs unawaited, hiding its latency under the current model
  request and tool execution. DSH's span-stability assertion still rejects the
  commit if anything disturbs the selected region, and a failed background
  fold is logged and retried on the next pre-step instead of breaking the turn.
- `foldTiming: "sync"` restores the previous blocking behavior where the step
  awaits the fold before the next model request.

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
