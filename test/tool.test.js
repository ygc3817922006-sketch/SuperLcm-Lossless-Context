import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendRecallEnvelope } from '../src/marker.js'
import { SuperLcmStore } from '../src/store.js'
import { apply, createSuperLcmToolDefinitions } from '../src/tool.js'

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
  const store = new SuperLcmStore(join(dir, 'lcm.sqlite'))
  const summary = appendRecallEnvelope([{ type: 'text', text: 'historical compiler decision' }], {
    id: 'node-12345678',
  })
  const session = {
    id: 'session-tools',
    events: [
      { seq: 7, type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'original contract wording' }] } },
      { seq: 8, type: 'compaction/start', time: 2, data: { compactionId: 'c' } },
      { seq: 9, type: 'compaction/summary', time: 3, data: { compactionId: 'c', summary, shadowedSeqs: [7] } },
      { seq: 10, type: 'user/message', time: 4, data: { content: summary, source: { kind: 'plugin', plugin: 'compact', compactionId: 'c' } }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [8, 9, 7] },
      { seq: 11, type: 'compaction/end', time: 5, data: { compactionId: 'c' } },
    ],
  }
  try {
    await run({ store, session, definitions: createSuperLcmToolDefinitions(store) })
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


test('expand query enforces max_chars across all matches', async () => withDefinitions(async ({ store, definitions, session }) => {
  const exec = { agent: { session } }
  const grep = definitions.find(definition => definition.name === 'lcm_grep')
  await grep.execute({ query: 'compiler decision', scope: 'summary' }, exec)
  store.upsertNode({
    sessionId: session.id,
    nodeId: 'node-87654321',
    createdAt: 99,
    summary: [{ type: 'text', text: 'another compiler decision' }],
    summaryText: 'another compiler decision',
    childIds: [],
    sourceSeqs: [7],
    status: 'ready',
  })
  const expandQuery = definitions.find(definition => definition.name === 'lcm_expand_query')
  const result = await expandQuery.execute({ query: 'compiler decision', limit: 2, max_chars: 1 }, exec)
  assert.equal(result.matches.length, 2)
  assert.ok(result.returnedChars <= 1)
  assert.ok(result.matches.flatMap(match => match.expansion?.chunks ?? []).reduce((n, chunk) => n + chunk.content.length, 0) <= 1)
}))

test('doctor is read-only unless repair is explicitly true', async () => withDefinitions(async ({ store, definitions, session }) => {
  const exec = { agent: { session } }
  const doctor = definitions.find(definition => definition.name === 'lcm_doctor')
  const observed = await doctor.execute({ repair: false }, exec)
  assert.equal(observed.reindex, null)
  assert.equal(observed.report.ok, false)
  assert.equal(store.stats(session.id).nodeCount, 0)

  const repaired = await doctor.execute({ repair: true }, exec)
  assert.equal(repaired.reindex.indexed, 1)
  assert.equal(repaired.report.ok, true)
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
