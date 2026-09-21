import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AsyncSurfaceChangedError,
  commitAsyncRegion,
  prepareAsyncRegion,
  summarizeAsyncRegion,
} from '../src/async-region.js'
import { appendRecallEnvelope } from '../src/marker.js'

function fakeSession() {
  const events = [
    { seq: 0, type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: 'system' }] }, tokenCount: 10 },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'old one' }] }, tokenCount: 100 },
    { seq: 2, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'old two' }] }, tokenCount: 100 },
    { seq: 3, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'fresh tail' }] }, tokenCount: 100 },
  ]
  const session = {
    id: 'async-session',
    seq: events.length,
    events,
    surface: { nodes: [0, 1, 2, 3], replaceGeneration: 0 },
    requestHeader() { return { tools: [] } },
    eventAt(seq) { return events.find(event => event.seq === seq) },
    deriveEventMessage(event) { return event?.data ?? null },
    append(type, data, metadata = {}) {
      const event = { seq: this.seq++, type, data, ...metadata }
      events.push(event)
      const op = metadata.surfaceOp
      if (op?.op === 'replace') {
        const start = this.surface.nodes.indexOf(op.startSeq)
        const end = this.surface.nodes.indexOf(op.endSeq)
        this.surface.nodes.splice(start, end - start + 1, event.seq)
        this.surface.replaceGeneration += 1
      } else if (type.endsWith('/message')) {
        this.surface.nodes.push(event.seq)
      }
      return event
    },
  }
  return session
}

function fakeEngine(session) {
  return {
    ctx: {
      tokenMeter: {
        measure() {
          return {
            nodes: session.surface.nodes.map(seq => ({ seq, tokens: session.eventAt(seq)?.tokenCount ?? 10, heuristicTokens: session.eventAt(seq)?.tokenCount ?? 10 })),
          }
        },
        estimateMessage() { return 20 },
      },
    },
    async summarize(_input, _agent, _signal, metadata) {
      this.lastMetadata = metadata
      return {
        summary: [{ type: 'text', text: 'prepared summary' }],
        provider: 'summary-provider',
        model: 'summary-model',
        maxTokens: 1000,
        usage: { inputTokens: 200, outputTokens: 20 },
        rawOutput: { type: 'completed' },
      }
    },
  }
}


test('only checkpoint-source events contribute trusted DAG children', async () => {
  const session = fakeSession()
  const child = appendRecallEnvelope([{ type: 'text', text: 'child' }], { id: 'child-12345678' })
  session.events[1].data.content = child
  session.events[2].type = 'user/message'
  session.events[2].data = {
    role: 'user',
    content: child,
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'trusted-compaction' },
  }
  const engine = fakeEngine(session)
  const agent = { session }
  const prepared = prepareAsyncRegion(engine, agent, { start: 1, end: 2, reason: 'hard-pressure' })
  assert.deepEqual(prepared.trustedChildNodeIds, ['child-12345678'])
  await summarizeAsyncRegion(engine, agent, prepared, new AbortController().signal)
  assert.deepEqual(engine.lastMetadata, { trustedChildNodeIds: ['child-12345678'] })
})

test('staged summary commits atomically after unrelated tail growth', async () => {
  const session = fakeSession()
  const engine = fakeEngine(session)
  const agent = { session }
  const prepared = prepareAsyncRegion(engine, agent, { start: 1, end: 2, reason: 'background-batch' })
  const summarized = await summarizeAsyncRegion(engine, agent, prepared, new AbortController().signal)

  const appendedTail = session.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: 'new tail' }] })
  appendedTail.tokenCount = 30
  const result = commitAsyncRegion(engine, agent, summarized)

  assert.deepEqual(session.events.slice(-4).map(event => event.type), [
    'compaction/start',
    'compaction/summary',
    'user/message',
    'compaction/end',
  ])
  assert.equal(result.shadowedRange.start, 1)
  assert.equal(result.shadowedRange.end, 2)
  assert.deepEqual(result.shadowedSeqs, [1, 2])
  assert.deepEqual(session.surface.nodes.slice(-2), [3, appendedTail.seq])
  assert.equal(session.surface.replaceGeneration, 1)
})

test('staged summary is rejected before writing if its selected span changed', async () => {
  const session = fakeSession()
  const engine = fakeEngine(session)
  const agent = { session }
  const prepared = prepareAsyncRegion(engine, agent, { start: 1, end: 2, reason: 'background-batch' })
  const summarized = await summarizeAsyncRegion(engine, agent, prepared, new AbortController().signal)
  session.surface.nodes.splice(1, 2, 3)

  assert.throws(() => commitAsyncRegion(engine, agent, summarized), AsyncSurfaceChangedError)
  assert.equal(session.events.some(event => event.type === 'compaction/start'), false)
})
