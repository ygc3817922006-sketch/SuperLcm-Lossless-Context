import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendRecallEnvelope } from '../src/marker.js'
import { LosslessStore } from '../src/store.js'
import { apply, createLosslessToolDefinitions } from '../src/tool.js'

const EXPECTED_NAMES = [
  'lcm_grep',
  'lcm_describe',
  'lcm_expand',
  'lcm_expand_query',
  'lcm_reindex',
  'lcm_doctor',
]

async function withDefinitions(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-tools-'))
  const store = new LosslessStore(join(dir, 'lcm.sqlite'))
  const summary = appendRecallEnvelope([{ type: 'text', text: 'historical compiler decision' }], {
    id: 'node-12345678',
  })
  const session = {
    id: 'session-tools',
    events: [
      { seq: 7, type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'original contract wording' }] } },
      { seq: 12, type: 'compaction/summary', time: 2, data: { compactionId: 'c', summary, shadowedSeqs: [7] } },
    ],
  }
  try {
    await run({ store, session, definitions: createLosslessToolDefinitions(store) })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('six explicit public tool names are registered', async () => withDefinitions(({ definitions }) => {
  assert.deepEqual(definitions.map(definition => definition.name), EXPECTED_NAMES)
}))

test('tool calls require a live DSH agent session', async () => withDefinitions(({ definitions }) => {
  const grep = definitions.find(definition => definition.name === 'lcm_grep')
  assert.throws(() => grep.execute({ query: 'anything' }, {}), /live DSH agent session/)
}))

test('grep, describe and exact expand operate through the real core', async () => withDefinitions(async ({ definitions, session }) => {
  const exec = { agent: { session } }
  const grep = definitions.find(definition => definition.name === 'lcm_grep')
  const describe = definitions.find(definition => definition.name === 'lcm_describe')
  const expand = definitions.find(definition => definition.name === 'lcm_expand')

  const hits = await grep.execute({ query: 'compiler decision', scope: 'summary' }, exec)
  assert.equal(hits.summaries[0].nodeId, 'node-12345678')

  const metadata = await describe.execute({ node_id: 'node-12345678' }, exec)
  assert.deepEqual(metadata.sourceRange, { first: 7, last: 7 })

  const exact = await expand.execute({ node_id: 'node-12345678', max_chars: 5000 }, exec)
  assert.equal(exact.chunks[0].seq, 7)
  assert.match(exact.chunks[0].content, /original contract wording/)
  assert.equal(exact.next, null)
}))

test('apply registers tools and owns SQLite lifetime as a Cordis effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-apply-'))
  const previous = process.env.DSH_LOSSLESS_DB
  process.env.DSH_LOSSLESS_DB = join(dir, 'lcm.sqlite')
  const registrations = []
  const disposers = []
  const ctx = {
    tools: { register(definition) { registrations.push(definition.name) } },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  try {
    apply(ctx)
    assert.deepEqual(registrations, EXPECTED_NAMES)
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_LOSSLESS_DB
    else process.env.DSH_LOSSLESS_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
})
