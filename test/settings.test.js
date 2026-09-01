import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import LosslessCompactionEngine from '../src/engine.js'

async function withSettingsEngine(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-settings-'))
  const previous = process.env.DSH_LOSSLESS_DB
  process.env.DSH_LOSSLESS_DB = join(dir, 'lcm.sqlite')

  const disposers = []
  let installed
  let source
  const ctx = {
    logger: { info() {}, warn() {} },
    tokenMeter: { measure() { return { nodes: [], totalTokens: 0 } } },
    on() { return () => {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['settings'])
      callback({
        settings: {
          installSection(_owner, namespace, _schema, entry, options) {
            source = { ...entry }
            installed = { namespace, entry: { ...entry }, options }
            options.setSource(() => source)
          },
        },
      })
    },
  }

  const engine = new LosslessCompactionEngine(ctx, {
    thresholdRatio: 0.6,
    retainRatio: 0.16,
    summarizationProvider: '',
    summarizationModel: '',
  })

  try {
    await run({
      engine,
      installed,
      getSource: () => source,
      setSource: (next) => { source = next },
    })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_LOSSLESS_DB
    else process.env.DSH_LOSSLESS_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('summarizer route defaults to follow-agent and requires a complete pair', async () => withSettingsEngine(async ({ installed, getSource }) => {
  assert.equal(installed.namespace, 'lossless-context')
  assert.equal(installed.entry.summarizationProvider, '')
  assert.equal(installed.entry.summarizationModel, '')

  assert.throws(() => installed.options.validate({
    ...getSource(),
    summarizationProvider: 'openai',
    summarizationModel: '',
  }), /must both be set or both be empty/)

  assert.doesNotThrow(() => installed.options.validate({
    ...getSource(),
    summarizationProvider: '',
    summarizationModel: '',
  }))
}))

test('summarizer route applies live and blank pair restores follow-agent behavior', async () => withSettingsEngine(async ({ engine, installed, getSource, setSource }) => {
  const dedicated = {
    ...getSource(),
    summarizationProvider: '  openai  ',
    summarizationModel: '  gpt-5.6-sol  ',
  }
  installed.options.validate(dedicated)
  setSource(dedicated)
  installed.options.onChange()

  assert.equal(engine.config.summarizationProvider, 'openai')
  assert.equal(engine.config.summarizationModel, 'gpt-5.6-sol')

  const followAgent = {
    ...getSource(),
    summarizationProvider: '',
    summarizationModel: '',
  }
  installed.options.validate(followAgent)
  setSource(followAgent)
  installed.options.onChange()

  assert.equal(engine.config.summarizationProvider, '')
  assert.equal(engine.config.summarizationModel, '')
}))