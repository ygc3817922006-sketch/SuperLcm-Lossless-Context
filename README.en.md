# SuperLcm

[中文（默认）](./README.md) · [Project site](https://ygc3817922006-sketch.github.io/SuperLcm/) · [Releases](https://github.com/ygc3817922006-sketch/SuperLcm/releases)

A DSH-native SuperLcm lossless-recall context layer inspired by Lossless Claw / SuperLcm Management (LCM).

It keeps **DeepSeek Harness's append-only session log as the only raw-history source of truth**. Compaction summaries receive stable recall node identifiers; a derived SQLite index records the summary DAG and exact source event sequence numbers. The model can later search, inspect, and expand old context without pretending that a summary is the original text.

> Status: `0.3.0-alpha.9`. This is a public alpha. Pin both DSH and SuperLcm in a dedicated profile before enabling it in a primary workspace.

## Why SuperLcm

Traditional compaction often waits until context is nearly full, pauses the active request, and creates one flat summary. That makes the user wait, keeps the active prompt large for too long, and invalidates prompt caches when the leading history is rewritten.

SuperLcm is designed to:

1. **Compress asynchronously without blocking conversation.** It stages a safe range early and uses an explicit detached provider/model; the active agent never waits for that job.
2. **Keep active context smaller.** The model reads less stale material, retains more output headroom, and faces less long-context distraction.
3. **Protect the cacheable prefix.** The system message and committed checkpoints stay byte-stable; later folds touch only newer raw history.
4. **Reduce token and cache cost.** Shorter requests reduce input tokens, while a stable prefix improves prompt-cache reuse and avoids repeated cache writes. Exact savings depend on the provider.

## The LCM idea

SuperLcm is inspired by Clint Ehrlich and Theodore Blackman's paper **[LCM: Lossless Context Management](https://papers.voltropy.com/LCM)**. It manages long history as a hierarchical summary DAG while preserving pointers from every summary to its original messages.

Start with the paper team's **[official interactive visual explainer](https://www.losslesscontext.ai/)**. Its scroll-driven animation covers flat compaction, the fresh tail, incremental summaries, condensation, and selective expansion. The paper is also available as [arXiv:2605.04050](https://arxiv.org/abs/2605.04050).

In DSH, the event log remains immutable raw history; the active prompt carries only a frozen prefix, summary checkpoints, and recent raw turns; SQLite stores a rebuildable DAG and exact event sequences; recall tools recover original events on demand.

## What it does

- Uses the DSH session event log as canonical raw history; the plugin does not copy full transcripts into SQLite.
- Extends DSH's official `BasicCompactionEngine` and changes only the summary seam plus the automatic rolling admission policy.
- Adds a stable machine-readable marker to each committed summary.
- Builds a per-session hierarchical summary DAG from markers found in the compacted span.
- Keeps forked sessions isolated with the composite identity `(session_id, node_id)`.
- Recovers exact raw events by sequence number, including lossless pagination inside a single very large event.
- Incrementally indexes only complete successful compaction lifecycles; an explicit rebuild reconstructs SQLite from the canonical session log.
- Exposes six model-facing recall and repair tools: `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query`, `lcm_reindex`, and `lcm_doctor`.

## Summarizer model

Compaction summaries may use a model different from the main Agent. The plugin directly exposes DSH `BasicCompactionEngine`'s existing `summarizationProvider` / `summarizationModel` route rather than creating a second router.

In WebUI → Plugin configuration → SuperLcm, set both fields to any provider/model IDs routable by the installed DSH adapters, for example:

```text
Summarizer Provider: openai
Summarizer Model:    gpt-5.6-sol
```

Automatic compaction requires an explicit provider/model pair. Blank or half-configured routes are rejected, and background work never falls back to the active Agent or custom-subagent route. Changes apply to subsequent compactions immediately without a plugin restart.

## Fully asynchronous rolling compaction

SuperLcm supports one automatic policy: `mode: "rolling"` with `foldTiming: "background"`. Blocking `sync` timing and the old synchronous `threshold` mode are rejected.

The default policy keeps the newest 24 surface nodes and at least 32k recent tokens verbatim. A safe 64k raw-history batch may be summarized immediately by the detached worker, but the ready result stays off-surface until the 160k soft cap, 220k hard cap, or overflow requires reduction. After commit, the leading system message and every earlier committed checkpoint are frozen as an exact byte-stable prefix; later batches compact only raw history after that prefix. Only hard pressure may merge frozen checkpoints. Preparation and commit remain non-blocking.

The worker snapshots the selected surface, summarizes it through the plugin-configured route with its own abort controller, then commits only if the selected span and token-meter snapshot are still stable. Concurrent tail growth is allowed. A changed selected span is discarded and restaged later. Commit writes the normal durable `compaction/start`, `compaction/summary`, replacement `user/message`, and `compaction/end` transaction.

The complete policy and GPT-5.6 Sol starting values are documented in [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md).

## Cache optimization

SuperLcm does not guess prompt-cache TTL. The committed system message and checkpoints form the longest byte-stable prefix; routine folds touch only raw history after that prefix. Old checkpoints merge only when hard pressure cannot reclaim enough space from later history.

```text
SYSTEM · CHECKPOINT 01 · CHECKPOINT 02 │ RAW HISTORY │ FRESH TAIL
└──────────── byte-stable cacheable prefix ───────────┘
```

Shorter active requests reduce input tokens, while the stable prefix avoids repeated cache writes. Actual cache hits and pricing remain provider-specific.

## Non-goals and boundaries

This plugin does not replace gbrain or another long-term knowledge system. Its responsibility is the current DSH session and its descendants. Stable cross-session decisions should be promoted separately by the orchestrating agent or user.

“Lossless” means the raw DSH events remain available and summaries carry exact recovery pointers. It does **not** mean a summary itself contains every detail, nor does it eliminate model error during summarization.

SQLite is a derived index, not a second transcript database. Deleting it loses search acceleration and DAG metadata only; `lcm_reindex` can reconstruct it from complete successful compaction transactions in the DSH log. `lcm_doctor` is read-only unless `repair: true` is explicit.

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

### Cross-platform paths

Runtime code contains no macOS or `/Users/...` assumptions. Database paths resolve for the current OS in this order: explicit `DSH_SUPERLCM_DB`, then `DSH_HOME/SuperLcm/lcm.sqlite`, then `.dsh/SuperLcm/lcm.sqlite` under the platform user home. Node.js `node:path` and `node:os.homedir()` perform path resolution. CI covers Windows, Linux, and macOS on Node.js 22, plus Linux on Node.js 24.

### Install from the public release

Web profile:

```text
dsh plugin --profile web add "https://github.com/ygc3817922006-sketch/SuperLcm/releases/download/v0.3.0-alpha.9/SuperLcm-0.3.0-alpha.9.tgz"
```

ACP profile:

```text
dsh plugin --profile acp add "https://github.com/ygc3817922006-sketch/SuperLcm/releases/download/v0.3.0-alpha.9/SuperLcm-0.3.0-alpha.9.tgz"
```

Do not run unchecked `pnpm add` commands inside a production profile. Use `dsh plugin --profile ... add` so DSH manages profile dependencies and avoids duplicate core package instances.

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

Portable overrides:

| Variable | Meaning |
| --- | --- |
| `DSH_HOME` | DSH home directory; SuperLcm stores `SuperLcm/lcm.sqlite` below it. |
| `DSH_SUPERLCM_DB` | Explicit SQLite file path for the current operating system. |

Set these with the native environment-variable mechanism of your shell or service manager; no POSIX-only command is required.

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

Current automated coverage includes marker validation, DAG reconstruction, Unicode search fallback, session/fork isolation, SQLite transactions, exact source pointers, sparse event sequence ids, large-event pagination, tool registration, lifecycle disposal, failure containment, rolling selection, fully non-blocking pressure handling, independent cancellation, staged transaction stability, synchronous-mode rejection, and dedicated summarizer-route validation.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/CACHE_POLICY.md`](./docs/CACHE_POLICY.md).

## License and attribution

MIT. See [LICENSE](./LICENSE) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

SuperLcm is independent and is not affiliated with Voltropy, Martian Engineering, or DeepSeek. It does not vendor source files from LCM, Lossless Claw, or DSH.
