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
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  const engine = new LosslessCompactionEngine(ctx, config)
  try {
    await run({ engine, listeners })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_LOSSLESS_DB
    else process.env.DSH_LOSSLESS_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('engine delegates to BasicCompactionEngine and appends a parent marker', async () => withEngine(async ({ engine }) => {
  const childSummary = appendRecallEnvelope([{ type: 'text', text: 'older checkpoint' }], {
    id: 'child-12345678',
  })
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
  // Regression (2026-09-01 webui crash loop): the real DSH base constructor
  // invokes _registerAutomaticCompaction() DURING super(), before the
  // subclass's rollingConfig field is assigned. The stub base mirrors that
  // timing, so this construction itself would throw
  // "Cannot read properties of undefined (reading 'mode')" without the
  // queueMicrotask deferral in the engine hook.
  await Promise.resolve() // flush the deferred registration microtask
  assert.equal(typeof listeners.get('agent/pre-step'), 'function')
}))

test('background foldTiming starts the fold without blocking the step and serializes passes', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve() // flush the deferred registration microtask
  const preStep = listeners.get('agent/pre-step')
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  engine.rollingMaintain = async () => {
    calls += 1
    return gate.then(() => null)
  }
  const request = { agent: {}, signal: { aborted: false } }
  const next = () => 'next'

  // First pass: the listener resolves (step proceeds) while the fold is still
  // gated — the fold runs concurrently with the model request. calls === 1
  // proves the fold was started; the gate being closed proves it did not
  // block the step.
  const first = preStep(request, next)
  assert.equal(await first, 'next')
  assert.equal(calls, 1)

  release()
  await first.then(() => Promise.resolve())
  await new Promise((resolve) => setImmediate(resolve)) // let the fold chain settle

  // Second pass: settles the previous fold, then starts the next one.
  const second = preStep(request, next)
  assert.equal(await second, 'next')
  assert.equal(calls, 2)
}))

test('background fold failures are contained and do not block the step', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  engine.rollingMaintain = async () => { throw new Error('fold exploded') }
  const first = preStep({ agent: {}, signal: { aborted: false } }, () => 'next')
  assert.equal(await first, 'next')
  // The rejection is swallowed inside the fold chain — awaiting the stored
  // promise in the next pass must not rethrow.
  const second = preStep({ agent: {}, signal: { aborted: false } }, () => 'next')
  assert.equal(await second, 'next')
}))

test('sync foldTiming keeps the blocking pre-step behavior', async () => withEngine(async ({ engine, listeners }) => {
  await Promise.resolve()
  const preStep = listeners.get('agent/pre-step')
  let released = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  engine.rollingMaintain = async () => {
    await gate
    released = true
    return { shadowedSeqs: [1, 2], shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 42 }
  }
  const pending = preStep({ agent: {}, signal: { aborted: false } }, () => 'next')
  assert.equal(await Promise.race([pending, Promise.resolve('blocked')]), 'blocked')
  release()
  assert.equal(await pending, 'next')
  assert.equal(released, true)
}, { thresholdRatio: 0.8, foldTiming: 'sync' }))

test('committed compaction events are indexed after the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  const summary = appendRecallEnvelope([{ type: 'text', text: 'committed checkpoint' }], {
    id: 'node-12345678',
  })
  const session = { id: 'session-engine', events: [] }
  const event = {
    seq: 9,
    time: 100,
    type: 'compaction/summary',
    data: { compactionId: 'c1', summary, shadowedSeqs: [2, 4] },
  }
  listeners.get('session/event')(session, event)
  assert.equal(engine.losslessStore.getNode('session-engine', 'node-12345678').summaryText, 'committed checkpoint')
}))

test('post-commit SQLite failure is contained instead of corrupting the DSH transaction', async () => withEngine(async ({ engine, listeners }) => {
  engine.losslessStore.close()
  const summary = appendRecallEnvelope([{ type: 'text', text: 'still canonical in log' }], {
    id: 'node-87654321',
  })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => listeners.get('session/event')(
      { id: 'session-engine', events: [] },
      { seq: 10, type: 'compaction/summary', data: { summary, shadowedSeqs: [1] } },
    ))
  } finally {
    console.warn = originalWarn
  }
}))
