import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import LosslessCompactionEngine from '../src/engine.js'
import { appendRecallEnvelope, markerFromSummary } from '../src/marker.js'

async function withEngine(run, config = { thresholdRatio: 0.8 }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-engine-'))
  const previous = process.env.DSH_LOSSLESS_DB
  process.env.DSH_LOSSLESS_DB = join(dir, 'lcm.sqlite')
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tokenMeter: { measure(session) { return session.measurement } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
  }
  const engine = new LosslessCompactionEngine(ctx, config)
  try { await run({ engine, listeners }) }
  finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_LOSSLESS_DB
    else process.env.DSH_LOSSLESS_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('engine delegates to BasicCompactionEngine and appends a parent marker', async () => withEngine(async ({ engine }) => {
  const childSummary = appendRecallEnvelope([{ type: 'text', text: 'older checkpoint' }], { id: 'child-12345678' })
  const result = await engine.summarize({ messages: [{ role: 'user', content: childSummary }], baseText: 'new checkpoint' })
  const marker = markerFromSummary(result.summary)
  assert.equal(result.tokenCount, 7)
  assert.equal(result.summary[0].text, 'new checkpoint')
  assert.match(marker.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(marker.children, ['child-12345678'])
}))

test('engine preserves a base summarization failure', async () => withEngine(async ({ engine }) => {
  await assert.rejects(engine.summarize({ throwFromBase: true }), /base summary failed/)
}))

test('construction survives the base hook firing during super() and defers rolling registration', async () => withEngine(async ({ listeners }) => {
  await Promise.resolve()
  assert.equal(typeof listeners.get('agent/pre-step'), 'function')
}))

test('cache-aware defaults match the persistent Sol profile', async () => withEngine(async ({ engine }) => {
  assert.equal(engine.rollingConfig.tailCount, 24)
  assert.equal(engine.rollingConfig.minRetainTokens, 32000)
  assert.equal(engine.rollingConfig.pressureFoldTokens, 20000)
  assert.equal(engine.rollingConfig.foldBatchTokens, 64000)
  assert.equal(engine.rollingConfig.softActiveTokens, 160000)
  assert.equal(engine.rollingConfig.hardActiveTokens, 220000)
  assert.equal(engine.rollingConfig.cacheTtlSeconds, 1800)
  assert.equal(engine.rollingConfig.foldTiming, 'background')
}))

test('cache heuristic is conservative on first step and expires by TTL', async () => withEngine(async ({ engine }) => {
  let now = 1000
  engine.currentTimeMs = () => now
  const agent = {}
  assert.equal(engine.cacheHotFor(agent), true)
  now += 9000
  assert.equal(engine.cacheHotFor(agent), true)
  now += 11000
  assert.equal(engine.cacheHotFor(agent), false)
}, { thresholdRatio: 0.8, cacheTtlSeconds: 10 }))

test('planRolling uses full active-context tokens and the fresh token floor', async () => withEngine(async ({ engine }) => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, tokens: 6000 }))
  const session = { surface: { nodes: nodes.map(node => node.seq) }, measurement: { nodes, totalTokens: 180000 } }
  const selection = engine.planRolling({ session }, true)
  assert.equal(selection.reason, 'soft-cap')
  assert.ok(selection.tailTokens >= 32000)
  assert.equal(selection.activeTokens, 180000)
}))

test('soft pressure is awaited even when background timing is enabled', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  engine.cacheHotFor = () => true
  engine.planRolling = () => ({ start: 1, end: 2, foldTokens: 20000, tailNodes: 24, tailTokens: 32000, activeTokens: 170000, cacheHot: true, reason: 'soft-cap', tailCountRelaxed: false })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let committed = false
  engine.commitRollingSelection = async () => { await gate; committed = true; return { shadowedSeqs: [1, 2], shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 42 } }
  const pending = preStep({ agent, signal: { aborted: false } }, () => 'next')
  assert.equal(await Promise.race([pending, Promise.resolve('blocked')]), 'blocked')
  assert.equal(committed, false)
  release()
  assert.equal(await pending, 'next')
  assert.equal(committed, true)
}, { thresholdRatio: 0.8, foldTiming: 'background' }))

test('cold-batch background fold starts without blocking and serializes passes', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  engine.cacheHotFor = () => false
  engine.planRolling = () => ({ start: 1, end: 5, foldTokens: 64000, tailNodes: 24, tailTokens: 32000, activeTokens: 120000, cacheHot: false, reason: 'cold-batch', tailCountRelaxed: false })
  let calls = 0
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  engine.commitRollingSelection = async () => { calls += 1; if (calls === 1) await firstGate; return { shadowedSeqs: [1, 5], shadowedRange: { start: 1, end: 5 }, shadowedTokenCount: 42 } }
  const first = preStep({ agent, signal: { aborted: false } }, () => 'next')
  assert.equal(await first, 'next')
  assert.equal(calls, 1)
  const second = preStep({ agent, signal: { aborted: false } }, () => 'next')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  releaseFirst()
  assert.equal(await second, 'next')
  assert.equal(calls, 2)
  await engine.settleBackgroundFold(agent)
}, { thresholdRatio: 0.8, foldTiming: 'background' }))

test('background fold failures are contained and do not block the next step', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  engine.cacheHotFor = () => false
  engine.planRolling = () => ({ start: 1, end: 5, foldTokens: 64000, tailNodes: 24, tailTokens: 32000, activeTokens: 120000, cacheHot: false, reason: 'cold-batch', tailCountRelaxed: false })
  engine.commitRollingSelection = async () => { throw new Error('fold exploded') }
  assert.equal(await preStep({ agent, signal: { aborted: false } }, () => 'next'), 'next')
  assert.equal(await preStep({ agent, signal: { aborted: false } }, () => 'next'), 'next')
}))

test('sync foldTiming also awaits a cold-batch fold', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  engine.cacheHotFor = () => false
  engine.planRolling = () => ({ start: 1, end: 5, foldTokens: 64000, tailNodes: 24, tailTokens: 32000, activeTokens: 120000, cacheHot: false, reason: 'cold-batch', tailCountRelaxed: false })
  let release
  const gate = new Promise(resolve => { release = resolve })
  engine.commitRollingSelection = async () => { await gate; return { shadowedSeqs: [1, 5], shadowedRange: { start: 1, end: 5 }, shadowedTokenCount: 42 } }
  const pending = preStep({ agent, signal: { aborted: false } }, () => 'next')
  assert.equal(await Promise.race([pending, Promise.resolve('blocked')]), 'blocked')
  release()
  assert.equal(await pending, 'next')
}, { thresholdRatio: 0.8, foldTiming: 'sync' }))

test('committed compaction events are indexed after the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  const summary = appendRecallEnvelope([{ type: 'text', text: 'committed checkpoint' }], { id: 'node-12345678' })
  const session = { id: 'session-engine', events: [] }
  const event = { seq: 9, time: 100, type: 'compaction/summary', data: { compactionId: 'c1', summary, shadowedSeqs: [2, 4] } }
  listeners.get('session/event')(session, event)
  assert.equal(engine.losslessStore.getNode('session-engine', 'node-12345678').summaryText, 'committed checkpoint')
}))

test('post-commit SQLite failure is contained instead of corrupting the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  engine.losslessStore.close()
  const summary = appendRecallEnvelope([{ type: 'text', text: 'still canonical in log' }], { id: 'node-87654321' })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => listeners.get('session/event')({ id: 'session-engine', events: [] }, { seq: 10, type: 'compaction/summary', data: { summary, shadowedSeqs: [1] } }))
  } finally { console.warn = originalWarn }
}))
