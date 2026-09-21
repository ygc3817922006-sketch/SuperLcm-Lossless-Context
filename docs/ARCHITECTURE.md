# 架构 / Architecture

## Source-of-truth rule

```text
DSH append-only session event log
        │
        ├── raw user / assistant / tool events
        ├── committed compaction summary events
        └── surface replacement metadata
                 │
                 ▼
       SuperLcm
        ├── stable recall marker in each summary
        ├── summary DAG edges
        ├── exact source event sequence pointers
        └── derived SQLite search index
```

The DSH log is authoritative. SQLite may be deleted and rebuilt. The plugin never edits or deletes historical DSH events.

## Compaction path

`SuperLcmCompactionEngine` 继承官方 `BasicCompactionEngine`。手动压缩完整继承宿主的 `compactNow(agent, signal, sourceCommandId)`；自动路径则使用非阻塞 rolling worker。
`SuperLcmCompactionEngine` subclasses the official `BasicCompactionEngine`. Manual compaction inherits the complete host `compactNow(agent, signal, sourceCommandId)` contract; automatic compaction uses a non-blocking rolling worker:

1. Keep the leading system message and committed checkpoint prefix immutable.
2. Snapshot a balanced raw-history span after that prefix.
3. For detached rolling work, accept child node ids only from events whose source passes DSH `isCompactCheckpointSource`; arbitrary user-authored marker text is never trusted as a DAG edge.
4. Summarize on the explicitly configured provider/model with an independent abort controller.
5. Generate a fresh UUID node id and append the versioned recall envelope.
6. Atomically write `compaction/start`, `compaction/summary`, the checkpoint replacement `user/message`, and successful `compaction/end` only if the selected span is still stable.
7. The live listener indexes only on `compaction/end`, after correlating the complete successful lifecycle.

This sequencing matters: an incomplete, failed, cancelled, or mismatched transaction must not enter the derived index merely because an LLM returned text.

## Marker format

The marker is an HTML comment:

```text
<!-- dsh-lcm:v1:<base64url-json> -->
```

Decoded payload:

```json
{
  "v": 1,
  "id": "<stable node id>",
  "children": ["<older summary node id>"]
}
```

Ids are validated, duplicate child ids are removed, corrupt or unknown-version markers are ignored, and human-facing search text strips the envelope.

## Derived schema

SQLite tables:

- `lcm_nodes`: one row per `(session_id, node_id)`.
- `lcm_edges`: ordered parent-to-child summary edges.
- `lcm_nodes_fts`: FTS5 acceleration for summary search.
- `lcm_index_state`: per-session `last_committed_end_seq` high-water mark for incremental replay.
- `lcm_meta`: schema version.

A node stores summary blocks, normalized text, child ids, exact source sequence ids, token accounting, provider/model metadata, and status. During live indexing and replay, child edges are re-derived from `shadowedSeqs` that resolve to genuine compact-checkpoint source events; child claims embedded in summary text are never authoritative. The index does not store raw source event JSON.

## Fork isolation

A fork can inherit an old summary marker. Therefore `node_id` alone is not globally unique. All rows and edges are scoped by `session_id`; a parent and child session can carry the same marker id without overwriting each other.

## Exact expansion

`lcm_expand` resolves every cited sequence number against the calling agent's live session. It serializes the exact event and returns a bounded character page. The cursor contains:

```json
{
  "sourceOffset": 3,
  "eventCharOffset": 12000
}
```

The second field is required because a single tool result can exceed the whole page budget. Head/tail truncation would violate recoverability; the two-dimensional cursor lets callers continue through the middle.

Event lookup is by the event's `seq` field, not its array position, so sparse or reordered in-memory event arrays remain recoverable.

## Failure containment

Indexing happens only after a complete successful compaction lifecycle. Replay resumes after the last indexed `compaction/end`; the cursor advances only after its node is stored. An SQLite/indexing failure is logged and contained, does not roll back the canonical DSH transaction, and leaves the cursor retryable. `lcm_reindex` can rebuild derived state; `lcm_doctor` is read-only unless called with `repair: true`.

## Security and isolation

All model-facing tools obtain the session from `exec.agent.session`. They reject calls without a live agent and never accept an arbitrary session id from tool arguments. This prevents a tool call from selecting another session's index namespace.

## Deliberately deferred work

The alpha does not yet implement:

- multi-level rollup scheduling independent of rolling pressure compaction;
- focus briefs or task-specific context assembly;
- embedding retrieval;
- cross-session knowledge promotion;
- retention policies for stale SQLite namespaces;
- 与 Lossless Claw 的运行和诊断界面完全对齐 / full parity with Lossless Claw's operational and diagnostic surface.

These should be added behind explicit contracts rather than by bypassing the DSH session transaction.
