# Architecture

## Source-of-truth rule

```text
DSH append-only session event log
        │
        ├── raw user / assistant / tool events
        ├── committed compaction summary events
        └── surface replacement metadata
                 │
                 ▼
       dsh-lossless-context
        ├── stable recall marker in each summary
        ├── summary DAG edges
        ├── exact source event sequence pointers
        └── derived SQLite search index
```

The DSH log is authoritative. SQLite may be deleted and rebuilt. The plugin never edits or deletes historical DSH events.

## Compaction path

`LosslessCompactionEngine` subclasses the official `BasicCompactionEngine`. It deliberately does not reimplement pressure calculation, retention, cancellation, transaction boundaries, surface replacement, or convergence. It overrides `summarize()` only:

1. Inspect the input region selected by DSH.
2. Extract recall markers from any older checkpoint summaries inside that region.
3. Call the official base summarizer.
4. Generate a fresh UUID node id.
5. Append a visible recall instruction and a hidden versioned marker containing the node id and child ids.
6. Return the normal DSH summary result unchanged apart from the appended envelope.
7. After DSH commits a `compaction/summary` event, index it through the `session/event` listener.

This sequencing matters: an uncommitted or cancelled summary must not become authoritative merely because an LLM returned text.

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
- `lcm_meta`: schema version.

A node stores summary blocks, normalized text, child ids, exact source sequence ids, token accounting, provider/model metadata, and status. It does not store raw source event JSON.

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

Indexing happens only after a committed compaction event. An SQLite/indexing failure is logged and contained; it does not roll back or crash the canonical DSH session transaction. `lcm_reindex` repairs the derived state later.

## Security and isolation

All model-facing tools obtain the session from `exec.agent.session`. They reject calls without a live agent and never accept an arbitrary session id from tool arguments. This prevents a tool call from selecting another session's index namespace.

## Deliberately deferred work

The alpha does not yet implement:

- asynchronous maintenance debt and background summary preparation;
- multi-level rollup scheduling independent of DSH pressure compaction;
- focus briefs or task-specific context assembly;
- embedding retrieval;
- cross-session knowledge promotion;
- retention policies for stale SQLite namespaces;
- full parity with Lossless Claw's operational and diagnostic surface.

These should be added behind explicit contracts rather than by bypassing the DSH session transaction.
