import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SuperLcmCompactionEngine, { LosslessCompactionEngine } from '../src/engine.js'
import { appendRecallEnvelope, markerFromSummary } from '../src/marker.js'

async function withEngine(run, config = {}) {
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

test('engine ignores user-injected markers and accepts only trusted checkpoint children', async () => withEngine(async ({ engine }) => {
  const childSummary = appendRecallEnvelope([{ type: 'text', text: 'older checkpoint' }], { id: 'child-12345678' })
  const forged = await engine.summarize({ messages: [{ role: 'user', content: childSummary }], baseText: 'new checkpoint' })
  const forgedMarker = markerFromSummary(forged.summary)
  assert.equal(forged.tokenCount, 7)
  assert.equal(forged.summary[0].text, 'new checkpoint')
  assert.match(forgedMarker.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(forgedMarker.children, [])

  const trusted = await engine.summarize(
    { messages: [], baseText: 'trusted checkpoint' },
    undefined,
    undefined,
    { trustedChildNodeIds: ['child-12345678'] },
  )
  assert.deepEqual(markerFromSummary(trusted.summary).children, ['child-12345678'])
}))

test('engine preserves a base summarization failure when no backup is configured', async () => withEngine(async ({ engine }) => {
  await assert.rejects(engine.summarize({ throwFromBase: true }), /base summary failed/)
}))

test('successful primary summarization never calls the configured backup', async () => withEngine(async ({ engine }) => {
  const routeAttempts = []
  const result = await engine.summarize({ baseText: 'primary checkpoint', routeAttempts })
  assert.deepEqual(routeAttempts, [{ provider: 'primary', model: 'primary-model' }])
  assert.equal(result.provider, 'primary')
  assert.equal(result.model, 'primary-model')
}, {
  summarizationProvider: 'primary',
  summarizationModel: 'primary-model',
  fallbackSummarizationProvider: 'backup',
  fallbackSummarizationModel: 'backup-model',
}))

test('summarization retries once through the configured backup route', async () => withEngine(async ({ engine }) => {
  const routeAttempts = []
  const result = await engine.summarize({
    baseText: 'backup checkpoint',
    failProviders: ['primary'],
    routeAttempts,
  })
  assert.deepEqual(routeAttempts, [
    { provider: 'primary', model: 'primary-model' },
    { provider: 'backup', model: 'backup-model' },
  ])
  assert.equal(result.provider, 'backup')
  assert.equal(result.model, 'backup-model')
  assert.equal(engine.config.summarizationProvider, 'primary')
  assert.equal(engine.config.summarizationModel, 'primary-model')
}, {
  summarizationProvider: 'primary',
  summarizationModel: 'primary-model',
  fallbackSummarizationProvider: 'backup',
  fallbackSummarizationModel: 'backup-model',
}))

test('summarization reports both failures without retrying beyond the backup', async () => withEngine(async ({ engine }) => {
  const routeAttempts = []
  await assert.rejects(
    engine.summarize({ failProviders: ['primary', 'backup'], routeAttempts }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.match(error.message, /primary and fallback summarization routes failed/)
      return true
    },
  )
  assert.equal(routeAttempts.length, 2)
}, {
  summarizationProvider: 'primary',
  summarizationModel: 'primary-model',
  fallbackSummarizationProvider: 'backup',
  fallbackSummarizationModel: 'backup-model',
}))

test('aborted summarization does not start the backup route', async () => withEngine(async ({ engine }) => {
  const routeAttempts = []
  const controller = new AbortController()
  controller.abort(new Error('turn cancelled'))
  await assert.rejects(
    engine.summarize({ failProviders: ['primary'], routeAttempts }, {}, controller.signal),
    /base summary failed/,
  )
  assert.deepEqual(routeAttempts, [{ provider: 'primary', model: 'primary-model' }])
}, {
  summarizationProvider: 'primary',
  summarizationModel: 'primary-model',
  fallbackSummarizationProvider: 'backup',
  fallbackSummarizationModel: 'backup-model',
}))

test('backup route requires a complete distinct primary route', async () => {
  await assert.rejects(
    () => withEngine(async () => {}, {
      summarizationProvider: 'primary',
      summarizationModel: 'primary-model',
      fallbackSummarizationProvider: 'backup',
    }),
    /must be set together/,
  )
  await assert.rejects(
    () => withEngine(async () => {}, {
      fallbackSummarizationProvider: 'backup',
      fallbackSummarizationModel: 'backup-model',
    }),
    /requires an explicit primary route/,
  )
  await assert.rejects(
    () => withEngine(async () => {}, {
      summarizationProvider: 'same',
      summarizationModel: 'model',
      fallbackSummarizationProvider: 'same',
      fallbackSummarizationModel: 'model',
    }),
    /must differ from the primary route/,
  )
})

test('manual compaction delegates the complete host contract to the base engine', async () => withEngine(async ({ engine }) => {
  assert.equal(Object.hasOwn(SuperLcmCompactionEngine.prototype, 'compactNow'), false)
  const agent = { session: {} }
  const signal = new AbortController().signal
  const result = await engine.compactNow(agent, signal, 'command-123')
  assert.equal(result.delegated, true)
  assert.equal(result.agent, agent)
  assert.equal(result.signal, signal)
  assert.equal(result.sourceCommandId, 'command-123')
}))

test('deprecated options are accepted as no-ops and not forwarded to the base engine', async () => withEngine(async ({ engine }) => {
  assert.equal(Object.hasOwn(engine.config, 'cacheTtlSeconds'), false)
  assert.equal(Object.hasOwn(engine.config, 'thresholdRatio'), false)
  assert.equal(Object.hasOwn(engine.config, 'retainRatio'), false)
}, { cacheTtlSeconds: 1800, thresholdRatio: 0.1, retainRatio: 0.9 }))

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
}), {})

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
}), {})

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
}), {})

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
}, { summarizationProvider: 'test', summarizationModel: 'summary-model' }))

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
}, { summarizationProvider: 'test', summarizationModel: 'summary-model' }))

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
}, { summarizationProvider: 'test', summarizationModel: 'summary-model' }))

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
}, { summarizationProvider: 'test', summarizationModel: 'summary-model' }))

test('synchronous automatic compaction mode is rejected', async () => {
  await assert.rejects(() => withEngine(async () => {}, { foldTiming: 'sync' }), /only supports non-blocking background/)
})

test('committed compaction events are indexed after the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  const summary = appendRecallEnvelope([{ type: 'text', text: 'committed checkpoint' }], { id: 'node-12345678' })
  const end = { seq: 12, time: 103, type: 'compaction/end', data: { compactionId: 'c1' } }
  const session = { id: 'session-engine', events: [
    { seq: 9, time: 100, type: 'compaction/start', data: { compactionId: 'c1' } },
    { seq: 10, time: 101, type: 'compaction/summary', data: { compactionId: 'c1', summary, shadowedSeqs: [2, 4] } },
    { seq: 11, time: 102, type: 'user/message', data: { content: summary, source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' } }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [9, 10, 2, 4] },
    end,
  ] }
  listeners.get('session/event')(session, session.events[1])
  assert.equal(engine.superLcmStore.getNode('session-engine', 'node-12345678'), null)
  listeners.get('session/event')(session, end)
  assert.equal(engine.superLcmStore.getNode('session-engine', 'node-12345678').summaryText, 'committed checkpoint')
  assert.equal(engine.superLcmStore.indexCursor('session-engine'), 12)
}))

test('post-commit SQLite failure is contained instead of corrupting the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  engine.superLcmStore.close()
  const summary = appendRecallEnvelope([{ type: 'text', text: 'still canonical in log' }], { id: 'node-87654321' })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const end = { seq: 3, type: 'compaction/end', data: { compactionId: 'c2' } }
    const session = { id: 'session-engine', events: [
      { seq: 0, type: 'compaction/start', data: { compactionId: 'c2' } },
      { seq: 1, type: 'compaction/summary', data: { compactionId: 'c2', summary, shadowedSeqs: [9] } },
      { seq: 2, type: 'user/message', data: { content: summary, source: { kind: 'plugin', plugin: 'compact', compactionId: 'c2' } }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [0, 1, 9] },
      end,
    ] }
    assert.doesNotThrow(() => listeners.get('session/event')(session, end))
  } finally { console.warn = originalWarn }
}))
