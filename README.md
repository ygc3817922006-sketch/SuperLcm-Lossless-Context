# dsh-lossless-context

A DSH-native lossless-recall context layer inspired by Lossless Claw / Lossless Context Management (LCM).

It keeps **DeepSeek Harness's append-only session log as the only raw-history source of truth**. Compaction summaries receive stable recall node identifiers; a derived SQLite index records the summary DAG and exact source event sequence numbers. The model can later search, inspect, and expand old context without pretending that a summary is the original text.

> Status: `0.1.0-alpha.1`. This is a functional minimum port of the lossless-recall architecture, not feature parity with the complete Lossless Claw project. Deferred/background compaction, focus briefs, cross-session rollups, embeddings, and a production DSH desktop integration test are still future work.

中文说明：[README.zh-CN.md](./README.zh-CN.md)

## What it does

- Uses the DSH session event log as canonical raw history; the plugin does not copy full transcripts into SQLite.
- Extends DSH's official `BasicCompactionEngine` and changes only the summary seam.
- Adds a stable machine-readable marker to each committed summary.
- Builds a per-session hierarchical summary DAG from markers found in the compacted span.
- Keeps forked sessions isolated with the composite identity `(session_id, node_id)`.
- Recovers exact raw events by sequence number, including lossless pagination inside a single very large event.
- Rebuilds the entire derived SQLite index from the canonical session log.
- Exposes six model-facing recall and repair tools:
  - `lcm_grep`
  - `lcm_describe`
  - `lcm_expand`
  - `lcm_expand_query`
  - `lcm_reindex`
  - `lcm_doctor`

## Non-goals and boundaries

This plugin does not replace gbrain or another long-term knowledge system. Its responsibility is the current DSH session and its descendants. Stable cross-session decisions should be promoted separately by the orchestrating agent or user.

“Lossless” means the raw DSH events remain available and summaries carry exact recovery pointers. It does **not** mean a summary itself contains every detail, nor does it eliminate model error during summarization.

SQLite is a derived index, not a second transcript database. Deleting it loses search acceleration and DAG metadata only; `lcm_reindex` can reconstruct it from committed summary events in the DSH log.

## Requirements

- Node.js 22.16 or newer (`node:sqlite` is used).
- A DSH build exposing:
  - `@deepseek-ai/dsh-compaction-basic`
  - `@deepseek-ai/dsh-tools`
  - the `session/event` lifecycle used by the official compaction stack.

DSH is still evolving. Pin the plugin and DSH versions together in a dedicated profile before enabling it in a primary workspace.

## Installation

From a local checkout:

```bash
npm pack
# Install the generated .tgz using the package/plugin installation mechanism
# used by your isolated DSH profile.
```

Do not run `pnpm add` blindly inside a production DSH profile if it causes duplicate copies of core DSH packages. DSH runtime services use shared symbols; duplicated core packages can create runtime-instance mismatches. Prefer a dedicated development profile and verify its dependency tree before startup.

## Safe activation

The bundled [`cordis.patch.yml`](./cordis.patch.yml) is deliberately safe by default: it mounts only the six recall/repair tools. It does **not** auto-mount a second `ctx.compaction` provider.

### Stage A — tools only

Install the package in an isolated profile and let the bundled patch load:

```yaml
- insert:
    - id: dsh-lossless-context-tools
      name: dsh-lossless-context/tool
```

The tools can inspect/reindex LCM-marked summaries. Before this plugin has produced any marked summaries, raw-event search still works but the summary DAG will be empty.

### Stage B — replace the compaction provider

DSH should have only one compaction provider in an isolated agent context. In the profile's existing compaction node, **replace its plugin name** with:

```yaml
name: dsh-lossless-context
```

Do not append this beside the official basic provider. Preserve the existing node id, isolation boundary, and known-good compaction configuration unless a DSH version change requires otherwise. See [`examples/enable-compaction.patch.yml`](./examples/enable-compaction.patch.yml).

Keep the plugin disabled until static checks and tests pass in the development profile. Then start a disposable DSH session and verify the sequence in [`docs/VALIDATION.md`](./docs/VALIDATION.md).

## Storage

Default database path:

```text
~/.dsh/lossless-context/lcm.sqlite
```

Overrides:

```bash
export DSH_HOME=/custom/dsh/home
export DSH_LOSSLESS_DB=/absolute/path/lcm.sqlite
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

Repair the derived index:

```json
{"repair":true}
```

## Development

```bash
npm run validate
npm pack --dry-run
```

The test runner creates temporary local peer stubs only when `node_modules` is absent, then removes them. It refuses to overwrite a real dependency installation.

Current automated coverage includes marker validation, DAG reconstruction, Unicode search fallback, session/fork isolation, SQLite transactions, exact source pointers, sparse event sequence ids, large-event pagination, tool registration, lifecycle disposal, and failure containment.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## License and attribution

MIT. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). No Lossless Claw or DSH source file is vendored in this alpha; the implementation follows their published architectural seams and ideas.
