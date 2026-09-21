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
  nodeLevel,
  reindexSession,
  searchSuperLcmContext,
  searchSessionEvents,
} from '../src/core.js'
import { appendRecallEnvelope } from '../src/marker.js'
import { SuperLcmStore } from '../src/store.js'

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-core-'))
  const store = new SuperLcmStore(join(dir, 'lcm.sqlite'))
  const huge = 'BEGIN-' + '0123456789'.repeat(350) + '-END'
  const childSummary = appendRecallEnvelope([{ type: 'text', text: 'child checkpoint about H800 profiling' }], {
    id: 'child-12345678',
    children: ['forged-12345678'],
  })
  const parentSummary = appendRecallEnvelope([{ type: 'text', text: 'parent checkpoint about the final optimization route' }], {
    id: 'parent-12345678',
  })
  const events = [
    { seq: 0, time: 100, type: 'user/message', data: { content: [{ type: 'text', text: 'diagnose H800 performance' }] }, surfaceOp: { op: 'append' } },
    { seq: 1, time: 101, type: 'tool/result', data: { content: [{ type: 'text', text: huge }] }, surfaceOp: { op: 'append' } },
    { seq: 2, time: 102, type: 'compaction/start', data: { compactionId: 'compact-child' } },
    { seq: 3, time: 103, type: 'compaction/summary', data: { compactionId: 'compact-child', summary: childSummary, shadowedSeqs: [0, 1], shadowedTokenCount: 1000, provider: 'p', model: 'm' } },
    { seq: 4, time: 104, type: 'user/message', data: { content: childSummary, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-child' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [2, 3, 0, 1] },
    { seq: 5, time: 105, type: 'compaction/end', data: { compactionId: 'compact-child' } },
    { seq: 6, time: 106, type: 'assistant/message', data: { content: [{ type: 'text', text: 'more work after checkpoint' }] }, surfaceOp: { op: 'append' } },
    { seq: 7, time: 107, type: 'compaction/start', data: { compactionId: 'compact-parent' } },
    { seq: 8, time: 108, type: 'compaction/summary', data: { compactionId: 'compact-parent', summary: parentSummary, shadowedSeqs: [4, 6], shadowedTokenCount: 700, provider: 'p2', model: 'm2' } },
    { seq: 9, time: 109, type: 'user/message', data: { content: parentSummary, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-parent' } }, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 6 }, sourceEventSeqs: [7, 8, 4, 6] },
    { seq: 10, time: 110, type: 'compaction/end', data: { compactionId: 'compact-parent' } },
  ]
  const session = { id: 'session-a', events }
  try {
    await run({ store, session, events, huge })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('rc.2 snapshots restore indexing, search, exact recovery and doctor', async () => fixture(({ store, session, events }) => {
  const modern = { id: session.id, snapshotEvents() { return events }, get events() { throw new Error('legacy API used') } }
  assert.equal(reindexSession(store, modern).indexed, 2)
  assert.equal(searchSessionEvents(modern, 'diagnose H800')[0].seq, 0)
  const page = expandNode(store, modern, { nodeId: 'child-12345678' })
  assert.equal(page.chunks[0].content, JSON.stringify(events[0]))
  assert.equal(doctorSession(store, modern).ok, true)
}))

test('unsupported session API cannot erase an index or report healthy', async () => fixture(({ store, session }) => {
  reindexSession(store, session)
  const unreadable = { id: session.id }
  assert.throws(() => reindexSession(store, unreadable, { rebuild: true }), /unsupported session API/)
  assert.equal(store.stats(session.id).nodeCount, 2)
  assert.throws(() => doctorSession(store, unreadable), /unsupported session API/)
  assert.equal(doctorSession(store, { id: session.id, snapshotEvents: () => [] }).ok, false)
}))

test('compaction event becomes a node with exact cited event seqs', async () => fixture(({ session, events }) => {
  const node = nodeFromCompactionEvent(session, events[3])
  assert.equal(node.nodeId, 'child-12345678')
  assert.equal(node.summaryText, 'child checkpoint about H800 profiling')
  assert.deepEqual(node.sourceSeqs, [0, 1])
  assert.equal(node.shadowedTokenCount, 1000)
}))

test('reindex reconstructs the hierarchical DAG from committed log events', async () => fixture(({ store, session }) => {
  const result = reindexSession(store, session)
  assert.deepEqual(result, { sessionId: 'session-a', afterSeq: -1, scanned: 11, markers: 2, indexed: 2, errors: [] })
  const parent = describeNode(store, session, 'parent-12345678')
  assert.deepEqual(parent.childIds, ['child-12345678'])
  assert.equal(parent.sourceSeqCount, 2)
  const child = describeNode(store, session, 'child-12345678')
  assert.deepEqual(child.parentIds, ['parent-12345678'])
  assert.deepEqual(child.childIds, [])
}))


test('reindex ignores incomplete and failed compaction transactions', async () => fixture(({ store, session }) => {
  const incomplete = { id: 'session-incomplete', events: structuredClone(session.events.slice(0, 5)) }
  assert.equal(reindexSession(store, incomplete).indexed, 0)
  assert.equal(store.stats(incomplete.id).nodeCount, 0)

  const failed = { id: 'session-failed', events: structuredClone(session.events.slice(0, 6)) }
  failed.events[5].data.error = [{ name: 'Error', message: 'commit failed' }]
  assert.equal(reindexSession(store, failed).indexed, 0)
  assert.equal(store.stats(failed.id).nodeCount, 0)
}))

test('incremental reindex resumes after the last committed end', async () => fixture(({ store, session }) => {
  assert.equal(reindexSession(store, session).indexed, 2)
  assert.deepEqual(reindexSession(store, session), {
    sessionId: session.id,
    afterSeq: 10,
    scanned: 0,
    markers: 0,
    indexed: 0,
    errors: [],
  })
  session.events.push({ seq: 11, type: 'assistant/message', data: { content: [{ type: 'text', text: 'new tail' }] } })
  const tailOnly = reindexSession(store, session)
  assert.equal(tailOnly.afterSeq, 10)
  assert.equal(tailOnly.scanned, 1)
  assert.equal(tailOnly.indexed, 0)
}))

test('DAG level keeps branch-local cycle tracking for shared deep children', async () => fixture(({ store }) => {
  const sessionId = 'session-dag'
  const put = (nodeId, childIds = []) => store.upsertNode({
    sessionId,
    nodeId,
    createdAt: 1,
    summary: [],
    summaryText: nodeId,
    childIds,
    sourceSeqs: [],
    status: 'ready',
  })
  put('root-12345678', ['left-12345678', 'right-12345678'])
  put('left-12345678', ['shared-12345678'])
  put('right-12345678', ['bridge-12345678'])
  put('bridge-12345678', ['shared-12345678'])
  put('shared-12345678', ['deep-12345678'])
  put('deep-12345678', ['leaf-12345678'])
  put('leaf-12345678')
  assert.equal(nodeLevel(store, sessionId, 'root-12345678'), 6)
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
    events: events.map(event => {
      const clone = structuredClone(event)
      const remap = seq => 100 + seq * 7
      clone.seq = remap(event.seq)
      if (Array.isArray(clone.data?.shadowedSeqs)) clone.data.shadowedSeqs = clone.data.shadowedSeqs.map(remap)
      if (Array.isArray(clone.sourceEventSeqs)) clone.sourceEventSeqs = clone.sourceEventSeqs.map(remap)
      if (Number.isSafeInteger(clone.surfaceOp?.startSeq)) clone.surfaceOp.startSeq = remap(clone.surfaceOp.startSeq)
      if (Number.isSafeInteger(clone.surfaceOp?.endSeq)) clone.surfaceOp.endSeq = remap(clone.surfaceOp.endSeq)
      return clone
    }).reverse(),
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
  assert.equal(searchSessionEvents(session, 'more work')[0].seq, 6)

  const summaryOnly = searchSuperLcmContext(store, session, 'optimization route', { scope: 'summary' })
  assert.equal(summaryOnly.summaries[0].nodeId, 'parent-12345678')
  assert.deepEqual(summaryOnly.events, [])

  const eventsOnly = searchSuperLcmContext(store, session, 'H800 performance', { scope: 'events' })
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
  assert.equal(stale.ok, false, 'an index/log mismatch must not be reported as healthy')
}))

test('forked sessions may carry the same node id without overwriting each other', async () => fixture(({ store, session }) => {
  reindexSession(store, session)
  const fork = {
    id: 'session-fork',
    events: session.events.map(event => structuredClone(event)),
  }
  fork.events[3].data.summary = appendRecallEnvelope([{ type: 'text', text: 'fork-specific checkpoint' }], { id: 'child-12345678' })
  fork.events[4].data.content = fork.events[3].data.summary
  reindexSession(store, fork)

  assert.equal(store.getNode('session-a', 'child-12345678').summaryText, 'child checkpoint about H800 profiling')
  assert.equal(store.getNode('session-fork', 'child-12345678').summaryText, 'fork-specific checkpoint')
}))

test('exact expansion resolves sparse durable seq values rather than array indexes', async () => fixture(({ store, session }) => {
  const sparse = {
    id: 'session-sparse',
    events: session.events.map((event, index) => {
      const clone = structuredClone(event)
      const remap = seq => 100 + seq * 10
      clone.seq = 100 + index * 10
      if (Array.isArray(clone.data?.shadowedSeqs)) clone.data.shadowedSeqs = clone.data.shadowedSeqs.map(remap)
      if (Array.isArray(clone.sourceEventSeqs)) clone.sourceEventSeqs = clone.sourceEventSeqs.map(remap)
      if (Number.isSafeInteger(clone.surfaceOp?.startSeq)) clone.surfaceOp.startSeq = remap(clone.surfaceOp.startSeq)
      if (Number.isSafeInteger(clone.surfaceOp?.endSeq)) clone.surfaceOp.endSeq = remap(clone.surfaceOp.endSeq)
      return clone
    }),
  }
  sparse.events[3].data.shadowedSeqs = [sparse.events[0].seq, sparse.events[1].seq]
  sparse.events[8].data.shadowedSeqs = [sparse.events[4].seq, sparse.events[6].seq]
  reindexSession(store, sparse)
  const page = expandNode(store, sparse, { nodeId: 'child-12345678', maxChars: 10000 })
  assert.deepEqual(page.chunks.map(chunk => chunk.seq), [100, 110])
  assert.match(page.chunks[0].content, /diagnose H800 performance/)
}))

test('doctor detects source seqs that do not exist in a sparse log', async () => fixture(({ store, session }) => {
  const broken = structuredClone(session)
  broken.id = 'session-broken'
  broken.events[3].data.shadowedSeqs = [0, 999]
  broken.events[4].sourceEventSeqs = [2, 3, 0, 999]
  reindexSession(store, broken)
  const report = doctorSession(store, broken)
  assert.equal(report.ok, false)
  assert.deepEqual(report.invalidSources, [{ summarySeq: 3, sourceSeq: 999 }])
}))
