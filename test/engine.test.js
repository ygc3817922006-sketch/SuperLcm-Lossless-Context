import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SuperLcmCompactionEngine, { LosslessCompactionEngine } from '../src/engine.js'
import { appendRecallEnvelope, markerFromSummary } from '../src/marker.js'

async function withEngine(run, config = { thresholdRatio: 0.8 }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-engine-'))
  const previous = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tokenMeter: { measure(session) { return session.measurement } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
  }
  const engine = new SuperLcmCompactionEngine(ctx, config)
  try { await run({ engine, listeners }) }
  finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_SUPERLCM_DB
    else process.env.DSH_SUPERLCM_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('legacy engine export remains an alias', () => {
  assert.equal(LosslessCompactionEngine, SuperLcmCompactionEngine)
})

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

test('rolling defaults match the persistent Sol profile', async () => withEngine(async ({ engine }) => {
  assert.equal(engine.rollingConfig.tailCount, 24)
  assert.equal(engine.rollingConfig.minRetainTokens, 32000)
  assert.equal(engine.rollingConfig.pressureFoldTokens, 20000)
  assert.equal(engine.rollingConfig.foldBatchTokens, 64000)
  assert.equal(engine.rollingConfig.softActiveTokens, 160000)
  assert.equal(engine.rollingConfig.hardActiveTokens, 220000)
  assert.equal(engine.rollingConfig.foldTiming, 'background')
}))

test('planRolling uses full active-context tokens and the fresh token floor', async () => withEngine(async ({ engine }) => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, tokens: 6000 }))
  const session = { surface: { nodes: nodes.map(node => node.seq) }, measurement: { nodes, totalTokens: 180000 } }
  const selection = engine.planRolling({ session }, true)
  assert.equal(selection.reason, 'soft-cap')
  assert.ok(selection.tailTokens >= 32000)
  assert.equal(selection.activeTokens, 180000)
}))

test('planRolling protects a system message at surface node zero', async () => withEngine(async ({ engine }) => {
  const events = [
    { seq: 0, type: 'system/message' },
    ...Array.from({ length: 40 }, (_, index) => ({ seq: index + 1, type: 'user/message' })),
  ]
  const nodes = events.map(event => ({ seq: event.seq, tokens: 10000 }))
  const session = {
    surface: { nodes: nodes.map(node => node.seq) },
    measurement: { nodes, totalTokens: 410000 },
    eventAt(seq) { return events.find(event => event.seq === seq) },
  }
  const selection = engine.planRolling({ session }, false)
  assert.equal(selection.start, 1)
  assert.equal(selection.end, 16)
}), { thresholdRatio: 0.8 })

test('planRolling freezes committed checkpoints and only folds raw history after them', async () => withEngine(async ({ engine }) => {
  const frozen = appendRecallEnvelope([{ type: 'text', text: 'frozen summary' }], { id: 'frozen-12345678' })
  const events = [
    { seq: 0, type: 'system/message' },
    { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'fixture' }, content: frozen } },
    ...Array.from({ length: 40 }, (_, index) => ({ seq: index + 2, type: 'user/message' })),
  ]
  const nodes = events.map(event => ({ seq: event.seq, tokens: 10000 }))
  const session = {
    surface: { nodes: nodes.map(node => node.seq) },
    measurement: { nodes, totalTokens: 150000 },
    eventAt(seq) { return events.find(event => event.seq === seq) },
  }
  const selection = engine.planRolling({ session })
  assert.equal(selection.start, 2)
  assert.ok(selection.end > selection.start)
}), { thresholdRatio: 0.8 })

test('hard pressure may merge frozen checkpoints only when no later range can shrink', async () => withEngine(async ({ engine }) => {
  const summary = (id) => appendRecallEnvelope([{ type: 'text', text: id }], { id })
  const events = [
    { seq: 0, type: 'system/message' },
    { seq: 1, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'fixture' }, content: summary('frozen-12345678') } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'fixture' }, content: summary('frozen-23456789') } },
    { seq: 3, type: 'user/message' },
  ]
  const nodes = events.map(event => ({ seq: event.seq, tokens: 50000 }))
  const session = {
    surface: { nodes: nodes.map(node => node.seq) },
    measurement: { nodes, totalTokens: 240000 },
    eventAt(seq) { return events.find(event => event.seq === seq) },
  }
  const selection = engine.planRolling({ session })
  assert.equal(selection.reason, 'hard-cap')
  assert.equal(selection.start, 1)
  assert.equal(selection.end, 2)
}), { thresholdRatio: 0.8 })

test('soft pressure starts detached summarization without blocking the turn', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  const selection = { start: 1, end: 2, foldTokens: 20000, tailNodes: 24, tailTokens: 32000, activeTokens: 170000, reason: 'soft-cap', tailCountRelaxed: false }
  let planned = false
  engine.planRolling = () => planned ? null : (planned = true, selection)
  engine.prepareBackgroundSelection = (_agent, value) => value
  let release
  const gate = new Promise(resolve => { release = resolve })
  let detachedSignal
  engine.summarizeBackgroundSelection = async (_agent, prepared, signal) => { detachedSignal = signal; await gate; return prepared }
  engine.commitBackgroundSelection = (_agent, summarized) => ({ shadowedSeqs: [1, 2], shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 42, rollingPolicy: summarized })

  const turnController = new AbortController()
  assert.equal(await preStep({ agent, signal: turnController.signal }, () => 'next'), 'next')
  assert.ok(detachedSignal instanceof AbortSignal)
  assert.notEqual(detachedSignal, turnController.signal)
  turnController.abort()
  assert.equal(detachedSignal.aborted, false)
  assert.equal(engine.tryCommitBackgroundFold(agent), null)
  release()
  await engine.settleBackgroundFold(agent)
  assert.equal(await preStep({ agent, signal: new AbortController().signal }, () => 'next'), 'next')
  assert.equal(engine.backgroundFolds.has(agent), false)
}, { thresholdRatio: 0.8, summarizationProvider: 'test', summarizationModel: 'summary-model' }))

test('routine summaries wait ready without mutating the prefix until pressure', async () => withEngine(async ({ engine }) => {
  const agent = { session: { measurement: { totalTokens: 100000 } } }
  let commits = 0
  engine.commitBackgroundSelection = () => { commits += 1; return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 64000 } }
  const readyState = () => ({ status: 'ready', selection: { reason: 'background-batch' }, summarized: {} })

  engine.backgroundFolds.set(agent, readyState())
  assert.equal(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
  assert.equal(commits, 0)
  assert.equal(engine.backgroundFolds.has(agent), true)

  agent.session.measurement.totalTokens = 170000
  assert.notEqual(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
  assert.equal(commits, 1)
}, { thresholdRatio: 0.8, summarizationProvider: 'test', summarizationModel: 'summary-model' }))

test('all fold reasons serialize through one nonblocking background worker', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  let plans = 0
  engine.planRolling = () => ({ start: 1, end: 5, foldTokens: 64000, tailNodes: 24, tailTokens: 32000, activeTokens: 230000, reason: plans++ === 0 ? 'hard-cap' : 'background-batch', tailCountRelaxed: false })
  engine.prepareBackgroundSelection = (_agent, value) => value
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  engine.summarizeBackgroundSelection = async (_agent, prepared) => { calls += 1; await gate; return prepared }
  engine.commitBackgroundSelection = () => ({ shadowedSeqs: [1, 5], shadowedRange: { start: 1, end: 5 }, shadowedTokenCount: 42 })

  assert.equal(await preStep({ agent, signal: new AbortController().signal }, () => 'next'), 'next')
  assert.equal(await preStep({ agent, signal: new AbortController().signal }, () => 'next'), 'next')
  assert.equal(calls, 1)
  release()
  await engine.settleBackgroundFold(agent)
  assert.equal(calls, 1)
}, { thresholdRatio: 0.8, summarizationProvider: 'test', summarizationModel: 'summary-model' }))

test('background summary failures are contained and allow a later restage', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  const agent = {}
  engine.planRolling = () => ({ start: 1, end: 5, foldTokens: 64000, tailNodes: 24, tailTokens: 32000, activeTokens: 120000, reason: 'background-batch', tailCountRelaxed: false })
  engine.prepareBackgroundSelection = (_agent, value) => value
  let calls = 0
  engine.summarizeBackgroundSelection = async () => { calls += 1; throw new Error('fold exploded') }
  assert.equal(await preStep({ agent, signal: new AbortController().signal }, () => 'next'), 'next')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await preStep({ agent, signal: new AbortController().signal }, () => 'next'), 'next')
  assert.equal(calls, 2)
}, { thresholdRatio: 0.8, summarizationProvider: 'test', summarizationModel: 'summary-model' }))

test('synchronous automatic compaction mode is rejected', async () => {
  await assert.rejects(() => withEngine(async () => {}, { thresholdRatio: 0.8, foldTiming: 'sync' }), /only supports non-blocking background/)
})

test('committed compaction events are indexed after the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  const summary = appendRecallEnvelope([{ type: 'text', text: 'committed checkpoint' }], { id: 'node-12345678' })
  const session = { id: 'session-engine', events: [] }
  const event = { seq: 9, time: 100, type: 'compaction/summary', data: { compactionId: 'c1', summary, shadowedSeqs: [2, 4] } }
  listeners.get('session/event')(session, event)
  assert.equal(engine.superLcmStore.getNode('session-engine', 'node-12345678').summaryText, 'committed checkpoint')
}))

test('post-commit SQLite failure is contained instead of corrupting the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  engine.superLcmStore.close()
  const summary = appendRecallEnvelope([{ type: 'text', text: 'still canonical in log' }], { id: 'node-87654321' })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => listeners.get('session/event')({ id: 'session-engine', events: [] }, { seq: 10, type: 'compaction/summary', data: { summary, shadowedSeqs: [1] } }))
  } finally { console.warn = originalWarn }
}))
