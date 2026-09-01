import test from 'node:test'
import assert from 'node:assert/strict'
import { selectRollingRange } from '../src/rolling.js'
import { nodeLevel } from '../src/core.js'
import { LosslessStore } from '../src/store.js'

function priced(seq, tokens) {
  return { seq, tokens }
}

test('rolling selection keeps the fresh tail and folds only the older head', () => {
  // 8 surface nodes of 10k tokens each; tail keeps the newest 3 nodes.
  const pricedNodes = [1, 2, 3, 4, 5, 6, 7, 8].map(seq => ({ seq, tokens: 10000 }))
  const selection = selectRollingRange(pricedNodes, pricedNodes.map(node => node.seq), {
    tailCount: 3,
    foldBatchTokens: 20000,
  })
  assert.deepEqual(selection, {
    start: 1,
    end: 5,
    foldTokens: 50000,
    tailNodes: 3,
  })
})

test('rolling selection returns null while the foldable head is below the batch floor', () => {
  const pricedNodes = [1, 2, 3, 4].map(seq => ({ seq, tokens: 1000 }))
  const selection = selectRollingRange(pricedNodes, pricedNodes.map(node => node.seq), {
    tailCount: 2,
    foldBatchTokens: 20000,
  })
  assert.equal(selection, null)
})

test('rolling selection honors the token floor in addition to the node count', () => {
  const pricedNodes = Array.from({ length: 6 }, (_, index) => ({ seq: index + 1, tokens: 5000 }))
  // tailCount 2 keeps 2 nodes (10k tokens) but the token floor demands 30k.
  const selection = selectRollingRange(pricedNodes, pricedNodes.map(node => node.seq), {
    tailCount: 2,
    minRetainTokens: 30000,
    foldBatchTokens: 20000,
  })
  // keeps nodes 4-6 (15k tokens, 3 nodes) and folds 1-3 (15k) — batch floor not met.
  assert.equal(selection, null)
})

test('rolling selection walks the boundary back to a balanced tool pair', () => {
  const pricedNodes = [1, 2, 3, 4, 5, 6].map(seq => ({ seq, tokens: 30000 }))
  const selection = selectRollingRange(pricedNodes, pricedNodes.map(node => node.seq), {
    tailCount: 2,
    foldBatchTokens: 20000,
    // the natural boundary (seq 4) is unbalanced; the walk-back stops at seq 2.
    isBalancedBefore: (seq) => seq === 2,
  })
  assert.equal(selection.end, 1)
  assert.equal(selection.foldTokens, 30000)
})

test('rolling selection returns null for an empty or mismatched surface', () => {
  assert.equal(selectRollingRange([], [], { tailCount: 2, foldBatchTokens: 1 }), null)
  assert.throws(() => selectRollingRange([{ seq: 1, tokens: 10 }], [1, 2], {}), /does not match/)
})

test('node level grows with children and survives corrupted indexes', () => {
  const store = new LosslessStore(':memory:')
  try {
    store.upsertNode({
      sessionId: 's', nodeId: 'level-1-node-a', summary: [], summaryText: 'a',
      childIds: [], sourceSeqs: [1, 2], createdAt: 1,
    })
    store.upsertNode({
      sessionId: 's', nodeId: 'level-2-node-b', summary: [], summaryText: 'b',
      childIds: ['level-1-node-a'], sourceSeqs: [3],
    })
    store.upsertNode({
      sessionId: 's', nodeId: 'level-3-node-c', summary: [], summaryText: 'c',
      childIds: ['level-2-node-b', 'level-1-node-a'], sourceSeqs: [4],
    })
    assert.equal(nodeLevel(store, 's', 'level-1-node-a'), 1)
    assert.equal(nodeLevel(store, 's', 'level-2-node-b'), 2)
    assert.equal(nodeLevel(store, 's', 'level-3-node-c'), 3)
    // a dangling child edge must not recurse forever
    store.upsertNode({
      sessionId: 's', nodeId: 'broken-node-01', summary: [], summaryText: 'x',
      childIds: ['missing-child-1'], sourceSeqs: [5],
    })
    assert.equal(nodeLevel(store, 's', 'broken-node-00'.slice(0, 0) + 'broken-node-01'), 2)
  } finally {
    store.close()
  }
})
