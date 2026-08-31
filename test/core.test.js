import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  describeNode,
  doctorSession,
  expandNode,
  nodeFromCompactionEvent,
  reindexSession,
  searchLosslessContext,
  searchSessionEvents,
} from '../src/core.js'
import { appendRecallEnvelope } from '../src/marker.js'
import { LosslessStore } from '../src/store.js'

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-core-'))
  const store = new LosslessStore(join(dir, 'lcm.sqlite'))
  const huge = 'BEGIN-' + '0123456789'.repeat(350) + '-END'
  const childSummary = appendRecallEnvelope([{ type: 'text', text: 'child checkpoint about H800 profiling' }], {
    id: 'child-12345678',
  })
  const parentSummary = appendRecallEnvelope([{ type: 'text', text: 'parent checkpoint about the final optimization route' }], {
    id: 'parent-12345678',
    children: ['child-12345678'],
  })
  const events = [
    { seq: 0, time: 100, type: 'user/message', data: { content: [{ type: 'text', text: 'diagnose H800 performance' }] }, surfaceOp: { op: 'append' } },
    { seq: 1, time: 101, type: 'tool/result', data: { content: [{ type: 'text', text: huge }] }, surfaceOp: { op: 'append' } },
    { seq: 2, time: 102, type: 'compaction/summary', data: { compactionId: 'compact-child', summary: childSummary, shadowedSeqs: [0, 1], shadowedTokenCount: 1000, provider: 'p', model: 'm' } },
    { seq: 3, time: 103, type: 'user/message', data: { content: childSummary }, surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1] },
    { seq: 4, time: 104, type: 'assistant/message', data: { content: [{ type: 'text', text: 'more work after checkpoint' }] }, surfaceOp: { op: 'append' } },
    { seq: 5, time: 105, type: 'compaction/summary', data: { compactionId: 'compact-parent', summary: parentSummary, shadowedSeqs: [3, 4], shadowedTokenCount: 700, provider: 'p2', model: 'm2' } },
  ]
  const session = { id: 'session-a', events }
  try {
    await run({ store, session, events, huge })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('compaction event becomes a node with exact cited event seqs', async () => fixture(({ session, events }) => {
  const node = nodeFromCompactionEvent(session, events[2])
  assert.equal(node.nodeId, 'child-12345678')
  assert.equal(node.summaryText, 'child checkpoint about H800 profiling')
  assert.deepEqual(node.sourceSeqs, [0, 1])
  assert.equal(node.shadowedTokenCount, 1000)
}))

test('reindex reconstructs the hierarchical DAG from committed log events', async () => fixture(({ store, session }) => {
  const result = reindexSession(store, session)
  assert.deepEqual(result, { sessionId: 'session-a', markers: 2, indexed: 2, errors: [] })
  const parent = describeNode(store, session, 'parent-12345678')
  assert.deepEqual(parent.childIds, ['child-12345678'])
  assert.equal(parent.sourceSeqCount, 2)
  const child = describeNode(store, session, 'child-12345678')
  assert.deepEqual(child.parentIds, ['parent-12345678'])
}))

test('exact expansion paginates inside a single large event without dropping its middle', async () => fixture(({ store, session, events }) => {
  reindexSession(store, session)
  const expected = JSON.stringify(events[1])
  let cursor = { sourceOffset: 1, eventCharOffset: 0 }
  let recovered = ''
  let pages = 0
  while (cursor !== null) {
    const page = expandNode(store, session, {
      nodeId: 'child-12345678',
      sourceOffset: cursor.sourceOffset,
      eventCharOffset: cursor.eventCharOffset,
      maxChars: 1000,
      recursiveDepth: 1,
    })
    recovered += page.chunks.map(chunk => chunk.content).join('')
    cursor = page.next
    pages += 1
    assert.ok(pages < 20)
  }
  assert.ok(pages > 1)
  assert.equal(recovered, expected)
}))



test('exact expansion resolves event sequence ids even when the event array is sparse or reordered', async () => fixture(({ store, session, events }) => {
  const sparse = {
    id: session.id,
    events: events.map(event => structuredClone(event)).reverse().map((event, index) => ({ ...event, seq: event.seq + 100 + index * 7 })),
  }
  const originalSummary = sparse.events.find(event => event.type === 'compaction/summary' && event.data.compactionId === 'compact-child')
  const rawEvent = sparse.events.find(event => event.type === 'tool/result')
  originalSummary.data.shadowedSeqs = [rawEvent.seq]
  reindexSession(store, sparse, { rebuild: true })

  const page = expandNode(store, sparse, {
    nodeId: 'child-12345678',
    maxChars: 100000,
  })
  assert.equal(page.chunks[0].seq, rawEvent.seq)
  assert.equal(page.chunks[0].content, JSON.stringify(rawEvent))
  assert.equal(page.next, null)
}))

test('search covers summary nodes and raw events independently', async () => fixture(({ store, session }) => {
  reindexSession(store, session)
  assert.equal(searchSessionEvents(session, 'more work')[0].seq, 4)

  const summaryOnly = searchLosslessContext(store, session, 'optimization route', { scope: 'summary' })
  assert.equal(summaryOnly.summaries[0].nodeId, 'parent-12345678')
  assert.deepEqual(summaryOnly.events, [])

  const eventsOnly = searchLosslessContext(store, session, 'H800 performance', { scope: 'events' })
  assert.equal(eventsOnly.events[0].seq, 0)
  assert.deepEqual(eventsOnly.summaries, [])
}))

test('doctor reports a healthy rebuildable index and detects stale derived rows', async () => fixture(({ store, session }) => {
  reindexSession(store, session)
  const healthy = doctorSession(store, session)
  assert.equal(healthy.ok, true)
  assert.equal(healthy.logMarkers, 2)

  store.upsertNode({
    sessionId: session.id,
    nodeId: 'stale-12345678',
    createdAt: 999,
    summary: [],
    summaryText: 'stale',
    childIds: [],
    sourceSeqs: [],
    status: 'ready',
  })
  const stale = doctorSession(store, session)
  assert.deepEqual(stale.staleInDb, ['stale-12345678'])
  assert.equal(stale.ok, true, 'stale derived rows are repairable and do not invalidate the canonical log')
}))

test('forked sessions may carry the same node id without overwriting each other', async () => fixture(({ store, session }) => {
  reindexSession(store, session)
  const fork = {
    id: 'session-fork',
    events: session.events.map(event => structuredClone(event)),
  }
  fork.events[2].data.summary = appendRecallEnvelope([{ type: 'text', text: 'fork-specific checkpoint' }], { id: 'child-12345678' })
  reindexSession(store, fork)

  assert.equal(store.getNode('session-a', 'child-12345678').summaryText, 'child checkpoint about H800 profiling')
  assert.equal(store.getNode('session-fork', 'child-12345678').summaryText, 'fork-specific checkpoint')
}))

test('exact expansion resolves sparse durable seq values rather than array indexes', async () => fixture(({ store, session }) => {
  const sparse = {
    id: 'session-sparse',
    events: session.events.map((event, index) => ({ ...structuredClone(event), seq: 100 + index * 10 })),
  }
  sparse.events[2].data.shadowedSeqs = [sparse.events[0].seq, sparse.events[1].seq]
  sparse.events[5].data.shadowedSeqs = [sparse.events[3].seq, sparse.events[4].seq]
  reindexSession(store, sparse)
  const page = expandNode(store, sparse, { nodeId: 'child-12345678', maxChars: 10000 })
  assert.deepEqual(page.chunks.map(chunk => chunk.seq), [100, 110])
  assert.match(page.chunks[0].content, /diagnose H800 performance/)
}))

test('doctor detects source seqs that do not exist in a sparse log', async () => fixture(({ store, session }) => {
  const broken = structuredClone(session)
  broken.id = 'session-broken'
  broken.events[2].data.shadowedSeqs = [0, 999]
  reindexSession(store, broken)
  const report = doctorSession(store, broken)
  assert.equal(report.ok, false)
  assert.deepEqual(report.invalidSources, [{ summarySeq: 2, sourceSeq: 999 }])
}))
