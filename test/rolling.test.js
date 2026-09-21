import test from 'node:test'
import assert from 'node:assert/strict'
import { selectRollingRange } from '../src/rolling.js'
import { nodeLevel } from '../src/core.js'
import { SuperLcmStore } from '../src/store.js'

test('rolling selection keeps the fresh tail and folds only the older head', () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7, 8].map(seq => ({ seq, tokens: 10000 }))
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 3, minRetainTokens: 30000, foldBatchTokens: 20000, pressureFoldTokens: 10000, softActiveTokens: 100000, hardActiveTokens: 120000, activeTokens: 80000, cacheHot: false })
  assert.deepEqual(selection, { start: 1, end: 5, foldTokens: 50000, tailNodes: 3, tailTokens: 30000, tailCountRelaxed: false, activeTokens: 80000, cacheHot: false, reason: 'cold-batch' })
})

test('rolling selection never folds the protected system head', () => {
  const nodes = Array.from({ length: 8 }, (_, index) => ({ seq: index, tokens: 10000 }))
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), {
    firstFoldableIndex: 1,
    tailCount: 3,
    minRetainTokens: 30000,
    foldBatchTokens: 20000,
    pressureFoldTokens: 10000,
    softActiveTokens: 100000,
    hardActiveTokens: 120000,
    activeTokens: 80000,
    cacheHot: false,
  })
  assert.equal(selection.start, 1)
  assert.equal(selection.end, 4)
  assert.equal(selection.foldTokens, 40000)
})

test('hot cache defers a routine batch below the soft cap', () => {
  const nodes = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, tokens: 10000 }))
  assert.equal(selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 3, minRetainTokens: 30000, foldBatchTokens: 64000, pressureFoldTokens: 20000, softActiveTokens: 160000, hardActiveTokens: 220000, activeTokens: 100000, cacheHot: true }), null)
})

test('soft pressure overrides a hot cache once a useful fold is available', () => {
  const nodes = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, tokens: 18000 }))
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 3, minRetainTokens: 32000, foldBatchTokens: 64000, pressureFoldTokens: 20000, softActiveTokens: 160000, hardActiveTokens: 220000, activeTokens: 180000, cacheHot: true })
  assert.equal(selection.reason, 'soft-cap')
  assert.equal(selection.cacheHot, true)
  assert.ok(selection.foldTokens >= 20000)
  assert.ok(selection.tailTokens >= 32000)
})

test('hard pressure forces any balanced non-empty foldable head', () => {
  const nodes = [{ seq: 1, tokens: 5000 }, { seq: 2, tokens: 5000 }, { seq: 3, tokens: 50000 }, { seq: 4, tokens: 50000 }]
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 2, minRetainTokens: 32000, pressureFoldTokens: 20000, foldBatchTokens: 64000, softActiveTokens: 160000, hardActiveTokens: 220000, activeTokens: 225000, cacheHot: true })
  assert.equal(selection.reason, 'hard-cap')
  assert.equal(selection.foldTokens, 10000)
})

test('hard pressure can relax the node-count tail without dropping the token floor', () => {
  const nodes = Array.from({ length: 6 }, (_, index) => ({ seq: index + 1, tokens: 40000 }))
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 24, minRetainTokens: 32000, pressureFoldTokens: 20000, foldBatchTokens: 64000, softActiveTokens: 160000, hardActiveTokens: 220000, activeTokens: 240000, cacheHot: true })
  assert.equal(selection.reason, 'hard-cap')
  assert.equal(selection.tailCountRelaxed, true)
  assert.equal(selection.tailNodes, 1)
  assert.equal(selection.tailTokens, 40000)
  assert.equal(selection.foldTokens, 200000)
})

test('rolling selection honors the token floor in addition to node count', () => {
  const nodes = Array.from({ length: 8 }, (_, index) => ({ seq: index + 1, tokens: 10000 }))
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 2, minRetainTokens: 40000, foldBatchTokens: 20000, activeTokens: 80000, cacheHot: false })
  assert.equal(selection.tailNodes, 4)
  assert.equal(selection.tailTokens, 40000)
  assert.equal(selection.end, 4)
})

test('rolling selection walks the boundary back to a balanced tool pair', () => {
  const nodes = [1, 2, 3, 4, 5, 6].map(seq => ({ seq, tokens: 30000 }))
  const selection = selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 2, minRetainTokens: 32000, foldBatchTokens: 20000, activeTokens: 180000, cacheHot: false, isBalancedBefore: seq => seq === 2 })
  assert.equal(selection.end, 1)
  assert.equal(selection.foldTokens, 30000)
  assert.equal(selection.tailNodes, 5)
  assert.equal(selection.tailTokens, 150000)
})

test('rolling selection returns null for empty, mismatched, or insufficient spans', () => {
  assert.equal(selectRollingRange([], [], {}), null)
  assert.throws(() => selectRollingRange([{ seq: 1, tokens: 10 }], [1, 2], {}), /does not match/)
  const nodes = [1, 2, 3, 4].map(seq => ({ seq, tokens: 1000 }))
  assert.equal(selectRollingRange(nodes, nodes.map(node => node.seq), { tailCount: 2, minRetainTokens: 2000, foldBatchTokens: 20000, activeTokens: 4000, cacheHot: false }), null)
})

test('node level grows with children and survives corrupted indexes', () => {
  const store = new SuperLcmStore(':memory:')
  try {
    store.upsertNode({ sessionId: 's', nodeId: 'level-1-node-a', summary: [], summaryText: 'a', childIds: [], sourceSeqs: [1, 2], createdAt: 1 })
    store.upsertNode({ sessionId: 's', nodeId: 'level-2-node-b', summary: [], summaryText: 'b', childIds: ['level-1-node-a'], sourceSeqs: [3] })
    store.upsertNode({ sessionId: 's', nodeId: 'level-3-node-c', summary: [], summaryText: 'c', childIds: ['level-2-node-b', 'level-1-node-a'], sourceSeqs: [4] })
    assert.equal(nodeLevel(store, 's', 'level-1-node-a'), 1)
    assert.equal(nodeLevel(store, 's', 'level-2-node-b'), 2)
    assert.equal(nodeLevel(store, 's', 'level-3-node-c'), 3)
    store.upsertNode({ sessionId: 's', nodeId: 'broken-node-01', summary: [], summaryText: 'x', childIds: ['missing-child-1'], sourceSeqs: [5] })
    assert.equal(nodeLevel(store, 's', 'broken-node-01'), 2)
  } finally { store.close() }
})
