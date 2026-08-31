import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LosslessStore, resolveDatabasePath } from '../src/store.js'

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-store-'))
  const store = new LosslessStore(join(dir, 'lcm.sqlite'))
  try {
    await run(store, dir)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

function node(overrides = {}) {
  return {
    sessionId: 'session-a',
    nodeId: 'node-12345678',
    compactionId: 'compact-a',
    summarySeq: 9,
    createdAt: 1000,
    summary: [{ type: 'text', text: '训练系统关键结论：保留原始事件。' }],
    summaryText: '训练系统关键结论：保留原始事件。',
    childIds: [],
    sourceSeqs: [1, 2, 3],
    shadowedTokenCount: 300,
    provider: 'provider-a',
    model: 'model-a',
    status: 'ready',
    ...overrides,
  }
}

test('resolveDatabasePath honors explicit database and DSH_HOME', () => {
  assert.equal(resolveDatabasePath({ DSH_LOSSLESS_DB: '/tmp/custom.sqlite' }), '/tmp/custom.sqlite')
  assert.equal(resolveDatabasePath({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/lossless-context/lcm.sqlite')
})

test('store persists nodes, exact source pointers, and DAG edges', async () => withStore(store => {
  store.upsertNode(node({ nodeId: 'child-12345678', summaryText: '旧摘要', sourceSeqs: [1] }))
  const inserted = store.upsertNode(node({
    nodeId: 'parent-12345678',
    childIds: ['child-12345678'],
    sourceSeqs: [4, 5],
  }))

  assert.equal(inserted.nodeId, 'parent-12345678')
  assert.deepEqual(inserted.sourceSeqs, [4, 5])
  assert.deepEqual(store.childrenOf('session-a', 'parent-12345678'), ['child-12345678'])
  assert.deepEqual(store.parentsOf('session-a', 'child-12345678'), ['parent-12345678'])
  assert.deepEqual(store.quickCheck(), ['ok'])
  assert.deepEqual(store.stats('session-a'), { nodeCount: 2, edgeCount: 1, missingChildren: [] })
}))

test('search uses FTS when available and authoritative Unicode substring fallback', async () => withStore(store => {
  store.upsertNode(node({ nodeId: 'node-chinese1', summaryText: '当前任务是训练系统性能诊断，结论不能猜。' }))
  store.upsertNode(node({ nodeId: 'node-english1', summaryText: 'Lossless context keeps exact session events.' }))

  assert.equal(store.searchNodes('session-a', '性能诊断')[0].nodeId, 'node-chinese1')
  assert.equal(store.searchNodes('session-a', 'exact session')[0].nodeId, 'node-english1')
  assert.deepEqual(store.searchNodes('session-a', ''), [])
}))

test('same node id is isolated by session id for forks', async () => withStore(store => {
  store.upsertNode(node({ sessionId: 'parent-session', summaryText: 'parent copy' }))
  store.upsertNode(node({ sessionId: 'child-session', summaryText: 'child copy' }))

  assert.equal(store.getNode('parent-session', 'node-12345678').summaryText, 'parent copy')
  assert.equal(store.getNode('child-session', 'node-12345678').summaryText, 'child copy')
  assert.equal(store.deleteSession('parent-session'), 1)
  assert.equal(store.getNode('parent-session', 'node-12345678'), null)
  assert.equal(store.getNode('child-session', 'node-12345678').summaryText, 'child copy')
}))

test('upsert replaces stale edges and FTS rows transactionally', async () => withStore(store => {
  store.upsertNode(node({ nodeId: 'child-11111111', summaryText: 'first child' }))
  store.upsertNode(node({ nodeId: 'child-22222222', summaryText: 'second child' }))
  store.upsertNode(node({ childIds: ['child-11111111'], summaryText: 'old phrase' }))
  store.upsertNode(node({ childIds: ['child-22222222'], summaryText: 'new phrase' }))

  assert.deepEqual(store.childrenOf('session-a', 'node-12345678'), ['child-22222222'])
  assert.equal(store.searchNodes('session-a', 'old phrase').length, 0)
  assert.equal(store.searchNodes('session-a', 'new phrase')[0].nodeId, 'node-12345678')
}))
