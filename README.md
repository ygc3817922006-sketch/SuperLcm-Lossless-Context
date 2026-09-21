# SuperLcm

A DSH-native SuperLcm lossless-recall context layer inspired by Lossless Claw / SuperLcm Management (LCM).

It keeps **DeepSeek Harness's append-only session log as the only raw-history source of truth**. Compaction summaries receive stable recall node identifiers; a derived SQLite index records the summary DAG and exact source event sequence numbers. The model can later search, inspect, and expand old context without pretending that a summary is the original text.

> Status: `0.3.0-alpha.2`. Rolling compaction is cache-aware, and the summarization provider/model can now be selected independently and changed live from the WebUI plugin settings. Exact raw recall remains backed by the DSH event log.

中文说明：[README.zh-CN.md](./README.zh-CN.md)

## What it does

- Uses the DSH session event log as canonical raw history; the plugin does not copy full transcripts into SQLite.
- Extends DSH's official `BasicCompactionEngine` and changes only the summary seam plus the automatic rolling admission policy.
- Adds a stable machine-readable marker to each committed summary.
- Builds a per-session hierarchical summary DAG from markers found in the compacted span.
- Keeps forked sessions isolated with the composite identity `(session_id, node_id)`.
- Recovers exact raw events by sequence number, including lossless pagination inside a single very large event.
- Rebuilds the entire derived SQLite index from the canonical session log.
- Exposes six model-facing recall and repair tools: `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query`, `lcm_reindex`, and `lcm_doctor`.

## Summarizer model

Compaction summaries may use a model different from the main Agent. The plugin directly exposes DSH `BasicCompactionEngine`'s existing `summarizationProvider` / `summarizationModel` route rather than creating a second router.

In WebUI → Plugin configuration → SuperLcm, set both fields to any provider/model IDs routable by the installed DSH adapters, for example:

```text
Summarizer Provider: openai
Summarizer Model:    gpt-5.6-sol
```

Leave **both** fields empty to follow the current Agent route. A dedicated route must set both fields; half-configured provider/model pairs are rejected. Changes apply to subsequent compactions immediately without a plugin restart.

DSH's current browser model directory is session-scoped, so this plugin intentionally does not bind the current conversation's `ModelSelect` to a global compaction setting. The two free-form fields can later become provider/model dropdowns without changing the underlying settings contract once DSH exposes a global model catalog.

## Compaction modes

The compaction provider supports two trigger policies via `mode`:

- `mode: "rolling"` (default) — cache-aware persistent-worker maintenance. The default policy keeps the newest 24 surface nodes and at least 32k recent tokens verbatim. Routine prefix mutation waits for a 64k foldable head and a cold-cache opportunity; a 160k active-context soft cap admits a useful fold from 20k, and a 220k hard cap forces any safe reduction. Soft/hard folds are synchronous even when `foldTiming` is `background`.
- `mode: "threshold"` — the official one-shot behavior of `BasicCompactionEngine`: compaction fires when measured tokens cross `thresholdRatio` of the routed model's context window, keeping `retainRatio`/`retainTokens` verbatim.

The cache heuristic uses `cacheTtlSeconds` (default 1800). The first observed model step is treated conservatively as cache-hot; later inter-step gaps inside that TTL defer routine prefix mutation. Set it to `0` to disable cache deferral.

Both modes preserve the official context-overflow recovery and reuse DSH's transactional `compactRegion`, including its compaction lock, replay validation, shrink check, and tool-pairing balance guard.

The complete policy, GPT-5.6 Sol starting values, background-stability limitation, and the deliberate boundary around future 20k leaf summarization are documented in [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md).

## Non-goals and boundaries

This plugin does not replace gbrain or another long-term knowledge system. Its responsibility is the current DSH session and its descendants. Stable cross-session decisions should be promoted separately by the orchestrating agent or user.

“Lossless” means the raw DSH events remain available and summaries carry exact recovery pointers. It does **not** mean a summary itself contains every detail, nor does it eliminate model error during summarization.

SQLite is a derived index, not a second transcript database. Deleting it loses search acceleration and DAG metadata only; `lcm_reindex` can reconstruct it from committed summary events in the DSH log.

## Requirements

- Node.js 22.16 or newer (`node:sqlite` is used).
- A DSH build exposing:
  - `@deepseek-ai/dsh-compaction-basic`
  - `@deepseek-ai/dsh-compaction`
  - `@deepseek-ai/dsh-llm`
  - `@deepseek-ai/dsh-tools`
  - the `session/event` lifecycle used by the official compaction stack.

DSH is still evolving. Pin the plugin and DSH versions together in a dedicated profile before enabling it in a primary workspace.

## Installation

From a local checkout:

```bash
npm pack
```

Do not run `pnpm add` blindly inside a production DSH profile if it causes duplicate copies of core DSH packages. DSH runtime services use shared symbols; duplicated core packages can create runtime-instance mismatches. Prefer a dedicated development profile and verify its dependency tree before startup.

## Safe activation

The bundled [`cordis.patch.yml`](./cordis.patch.yml) is deliberately safe by default: it mounts only the six recall/repair tools. It does **not** auto-mount a second `ctx.compaction` provider.

### Stage A — tools only

```yaml
- insert:
    - id: SuperLcm-tools
      name: SuperLcm/tool
```

### Stage B — replace the compaction provider

DSH should have only one compaction provider in an isolated agent context. In the profile's existing compaction node, replace its plugin name with:

```yaml
name: SuperLcm
```

Do not append this beside the official basic provider. Preserve the existing node id, isolation boundary, and known-good base compaction configuration unless a DSH version change requires otherwise. See [`examples/enable-compaction.patch.yml`](./examples/enable-compaction.patch.yml) for the recommended GPT-5.6 Sol persistent-worker policy.

Keep the plugin disabled until static checks and tests pass in the development profile. Then start a disposable DSH session and verify the sequence in [`docs/VALIDATION.md`](./docs/VALIDATION.md).

## Storage

Default database path:

```text
~/.dsh/SuperLcm/lcm.sqlite
```

Overrides:

```bash
export DSH_HOME=/custom/dsh/home
export DSH_SUPERLCM_DB=/absolute/path/lcm.sqlite
```

The database uses WAL mode and stores summaries, DAG edges, exact source sequence arrays, provider/model metadata, and a full-text index. It does not store duplicated raw event payloads.

## Tool usage

Search both compacted summaries and exact raw session events:

```json
{"query":"optimizer step","scope":"both","limit":20}
```

Inspect a node:

```json
{"node_id":"<node id>"}
```

Expand exact source events:

```json
{
  "node_id":"<node id>",
  "source_offset":0,
  "event_char_offset":0,
  "max_chars":30000,
  "recursive_depth":1
}
```

When `next` is non-null, call `lcm_expand` again with both cursor fields. This cursor can continue inside one large event, so the middle is not silently discarded.

## Development

```bash
npm run validate
npm pack --dry-run
```

Current automated coverage includes marker validation, DAG reconstruction, Unicode search fallback, session/fork isolation, SQLite transactions, exact source pointers, sparse event sequence ids, large-event pagination, tool registration, lifecycle disposal, failure containment, cache-aware rolling selection, pressure overrides, background-vs-synchronous admission, and live summarizer-route settings validation.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md).

## License and attribution

MIT. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). No Lossless Claw or DSH source file is vendored in this alpha; the implementation follows their published architectural seams and ideas.