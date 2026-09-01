import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import LosslessCompactionEngine from '../src/engine.js'
import { appendRecallEnvelope, markerFromSummary } from '../src/marker.js'

async function withEngine(run) {
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
  const engine = new LosslessCompactionEngine(ctx, { thresholdRatio: 0.8 })
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
