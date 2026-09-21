# Changelog

## 0.3.0-alpha.1 — 2026-09-21

- 将包名和 WebUI 配置界面统一改名为 SuperLcm。/ Rename the package and WebUI configuration surface to SuperLcm.
- 通过当前 `plugins.bundle.config` 宿主槽注册浏览器配置。/ Register browser configuration through the current `plugins.bundle.config` host slot.
- 迁移期间保留旧导出和旧 SQLite 路径。/ Preserve legacy exports and the old SQLite location during migration.

## 0.2.0-alpha.9 — 2026-09-14

- Read DSH rc.2 session events through `snapshotEvents()`, retaining the legacy array API for older hosts. Indexing, raw-event search, exact expansion and diagnostics use the same reader.
- Reject unsupported session APIs before rebuilding an index; never silently treat unavailable logs as empty. Doctor reports stale index entries as unhealthy without deleting them.
- Verified against this deployment's real v3 session using the installed rc.2 Session implementation: all 182 cited original events recovered exactly across eight pages. Original session and production SQLite index were not changed by this isolated verification. New automatic compaction is not covered by that replay.

## 0.2.0-alpha.8 — 2026-09-02

- The WebUI plugin card now offers the summarizer route as one dropdown fed by
  the Host model catalog (`remote.session.modelCatalog`, the same directory the
  main model picker reads), grouped by provider with a “follow the main Agent”
  entry that shows the current default. Choosing an entry saves the route
  atomically; unknown routes render as “custom”, and a manual provider/model
  form remains as a fallback when the catalog is unavailable.
- Rolling and cache-policy fields moved under a collapsed “advanced” section,
  regrouped into context limits / compaction rhythm / fallback compaction, with
  plain-language labels and shorter hints in both locales.
- `dsh.client.inject` now lists `@deepseek-ai/dsh-api-remotes` and
  `@deepseek-ai/dsh-api-session-controller`; the client entry injects
  `remote` and `remote.session`. Engine and settings keys are unchanged.

## 0.2.0-alpha.7 — 2026-09-01

- 通过 `SuperLcm` 设置区域暴露 DSH 原生的 `summarizationProvider` / `summarizationModel` 路由；两项留空表示“跟随当前 Agent 路由”。/ Expose DSH's native `summarizationProvider` / `summarizationModel` route through the `SuperLcm` settings section; both blank means “follow the current Agent route”. A dedicated summarizer requires both fields and applies live to later compactions without plugin reload.
- The WebUI plugin card now exposes the summarizer provider/model as free-form
  adapter IDs, plus the complete cache-aware rolling policy. It deliberately
  avoids binding the session-scoped conversation ModelSelect to this global
  compaction setting.
- Align WebUI fallbacks with the alpha.6 engine defaults: 32k fresh-token floor,
  20k pressure reduction, 64k routine batch, 160k/220k soft/hard caps, and a
  1800-second cache heuristic. The old browser-only 20k routine default is gone.
- Reject half-configured summarizer routes and add live-settings tests. The test
  schema stub now supports strings, and syntax validation includes `lib/` so a
  broken browser bundle fails CI before packaging.

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
  Host side, the engine registers a `SuperLcm` settings section via `settings.installSection`; 宿主侧引擎通过 `settings.installSection` 注册 `SuperLcm` 设置区域；changes apply live to `rollingConfig`, and the
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