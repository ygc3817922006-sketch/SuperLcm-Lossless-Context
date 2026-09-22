import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SuperLcmCompactionEngine from '../src/engine.js'

async function withSettingsEngine(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-settings-'))
  const previous = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')

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
            source = {
              ...entry,
              summarizationRoute: { ...entry.summarizationRoute },
              fallbackSummarizationRoute: { ...entry.fallbackSummarizationRoute },
            }
            installed = {
              namespace,
              entry: {
                ...entry,
                summarizationRoute: { ...entry.summarizationRoute },
                fallbackSummarizationRoute: { ...entry.fallbackSummarizationRoute },
              },
              options,
            }
            options.setSource(() => source)
          },
        },
      })
    },
  }

  const engine = new SuperLcmCompactionEngine(ctx, {
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
    if (previous === undefined) delete process.env.DSH_SUPERLCM_DB
    else process.env.DSH_SUPERLCM_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('summarizer route requires an explicit atomic provider-model pair', async () => withSettingsEngine(async ({ installed, getSource }) => {
  assert.equal(installed.namespace, 'superlcm')
  assert.deepEqual(installed.entry.summarizationRoute, { provider: '', model: '' })
  assert.deepEqual(installed.entry.fallbackSummarizationRoute, { provider: '', model: '' })

  assert.throws(() => installed.options.validate({
    ...getSource(),
    summarizationRoute: { provider: 'openai', model: '' },
  }), /requires an explicit summarization provider and model/)

  assert.throws(() => installed.options.validate({
    ...getSource(),
    summarizationRoute: { provider: '', model: '' },
  }), /requires an explicit summarization provider and model/)

  assert.throws(() => installed.options.validate({
    ...getSource(),
    summarizationRoute: { provider: 'openai', model: 'primary' },
    fallbackSummarizationRoute: { provider: 'anthropic', model: '' },
  }), /fallback summarization provider and model must be set together/)

  assert.throws(() => installed.options.validate({
    ...getSource(),
    summarizationRoute: { provider: 'openai', model: 'same' },
    fallbackSummarizationRoute: { provider: 'openai', model: 'same' },
  }), /fallback summarization route must differ/)
}))

test('atomic dedicated summarizer route applies live and blank changes are ignored', async () => withSettingsEngine(async ({ engine, installed, getSource, setSource }) => {
  const dedicated = {
    ...getSource(),
    summarizationRoute: { provider: '  openai  ', model: '  gpt-5.6-sol  ' },
    fallbackSummarizationRoute: { provider: '  anthropic  ', model: '  claude-sonnet  ' },
    tailCount: 31,
    minRetainTokens: 36000,
  }
  installed.options.validate(dedicated)
  setSource(dedicated)
  installed.options.onChange()

  assert.equal(engine.config.summarizationProvider, 'openai')
  assert.equal(engine.config.summarizationModel, 'gpt-5.6-sol')
  assert.deepEqual(engine.fallbackSummarizationRoute, { provider: 'anthropic', model: 'claude-sonnet' })
  assert.equal(engine.rollingConfig.tailCount, 31)
  assert.equal(engine.rollingConfig.minRetainTokens, 36000)

  const switched = {
    ...getSource(),
    summarizationRoute: { provider: 'anthropic', model: 'claude-opus-5' },
  }
  installed.options.validate(switched)
  setSource(switched)
  installed.options.onChange()

  assert.equal(engine.config.summarizationProvider, 'anthropic')
  assert.equal(engine.config.summarizationModel, 'claude-opus-5')
  assert.deepEqual(engine.fallbackSummarizationRoute, { provider: 'anthropic', model: 'claude-sonnet' })

  const withoutFallback = {
    ...getSource(),
    fallbackSummarizationRoute: { provider: '', model: '' },
  }
  installed.options.validate(withoutFallback)
  setSource(withoutFallback)
  installed.options.onChange()
  assert.deepEqual(engine.fallbackSummarizationRoute, { provider: '', model: '' })

  const followAgent = {
    ...getSource(),
    summarizationRoute: { provider: '', model: '' },
  }
  assert.throws(() => installed.options.validate(followAgent), /requires an explicit summarization provider and model/)
  setSource(followAgent)
  installed.options.onChange()

  assert.equal(engine.config.summarizationProvider, 'anthropic')
  assert.equal(engine.config.summarizationModel, 'claude-opus-5')
}))