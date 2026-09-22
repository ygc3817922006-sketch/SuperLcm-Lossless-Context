import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SuperLcmStore, resolveDatabasePath } from '../src/store.js'

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-store-'))
  const store = new SuperLcmStore(join(dir, 'lcm.sqlite'))
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

test('resolveDatabasePath honors explicit platform-native database paths', () => {
  const explicit = join(tmpdir(), 'custom-superlcm.sqlite')
  const legacy = join(tmpdir(), 'legacy-superlcm.sqlite')
  assert.equal(resolveDatabasePath({ DSH_SUPERLCM_DB: explicit, DSH_LOSSLESS_DB: legacy }), explicit)
  assert.equal(resolveDatabasePath({ DSH_LOSSLESS_DB: legacy }), legacy)
})

test('resolveDatabasePath selects the new home and preserves legacy fallback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'SuperLcm-home-'))
  try {
    assert.equal(resolveDatabasePath({ DSH_HOME: home }), join(home, 'SuperLcm', 'lcm.sqlite'))
    const legacyDir = join(home, 'lossless-context')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'lcm.sqlite'), '')
    assert.equal(resolveDatabasePath({ DSH_HOME: home }), join(home, 'lossless-context', 'lcm.sqlite'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})


test('schema v2 migrates the committed-end cursor into scan state without losing nodes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-migrate-'))
  const databasePath = join(dir, 'lcm.sqlite')
  let store = new SuperLcmStore(databasePath)
  try {
    store.upsertNode(node())
    store.close()
    const legacy = new DatabaseSync(databasePath)
    legacy.exec("DROP TABLE lcm_scan_state; INSERT INTO lcm_index_state(session_id, last_committed_end_seq) VALUES ('session-a', 42);")
    legacy.prepare("UPDATE lcm_meta SET value = '2' WHERE key = 'schema_version'").run()
    legacy.close()

    store = new SuperLcmStore(databasePath)
    assert.equal(store.getNode('session-a', 'node-12345678').summaryText, '训练系统关键结论：保留原始事件。')
    assert.equal(store.indexCursor('session-a'), 42)
    assert.equal(store.setIndexCursor('session-a', 41), 42)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('literal :memory: opens SQLite memory storage instead of a repository file', () => {
  const store = new SuperLcmStore(':memory:')
  try {
    assert.equal(store.path, ':memory:')
    store.upsertNode(node())
    assert.equal(store.getNode('session-a', 'node-12345678').summaryText, '训练系统关键结论：保留原始事件。')
  } finally {
    store.close()
  }
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
