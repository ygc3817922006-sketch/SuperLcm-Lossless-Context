import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SuperLcmCompactionEngine from '../src/engine.js'

// dsh 0.1.7: installSection 已删除，改为 Config volatile + loader/volatile-update。
// 这里模拟 Loader 的行为：把新 config 提交进 fiber.config 并触发事件。

async function withSettingsEngine(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lcm-settings-'))
  const previous = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')

  const disposers = []
  let fiberConfig
  const ctx = {
    logger: { info() {}, warn() {} },
    tokenMeter: { measure() { return { nodes: [], totalTokens: 0 } } },
    on(event, handler) {
      if (event === 'loader/volatile-update') volatileHandlers.push(handler)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    // dsh 0.1.7: Service 基类构造时经 ctx.reflect.provide 注册自身。
    reflect: { provide() {} },
    get fiber() { return { config: fiberConfig } },
  }
  const volatileHandlers = []

  const engine = new SuperLcmCompactionEngine(ctx, {
    summarizationProvider: '',
    summarizationModel: '',
  })

  // 模拟 loader/volatile-update：提交新 config 后触发事件。
  const commitConfig = (next) => {
    fiberConfig = next
    for (const handler of volatileHandlers) handler([])
  }

  try {
    await run({ engine, commitConfig })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_SUPERLCM_DB
    else process.env.DSH_SUPERLCM_DB = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('summarizer route requires an explicit atomic provider-model pair', async () => withSettingsEngine(async ({ engine, commitConfig }) => {
  assert.throws(() => engine.applyRuntimeConfig({
    summarizationProvider: 'openai',
    summarizationModel: '',
    fallbackSummarizationProvider: '',
    fallbackSummarizationModel: '',
  }), /requires an explicit summarization provider and model/)

  assert.throws(() => engine.applyRuntimeConfig({
    summarizationProvider: '',
    summarizationModel: '',
    fallbackSummarizationProvider: '',
    fallbackSummarizationModel: '',
  }), /requires an explicit summarization provider and model/)

  assert.throws(() => engine.applyRuntimeConfig({
    summarizationProvider: 'openai',
    summarizationModel: 'primary',
    fallbackSummarizationProvider: 'anthropic',
    fallbackSummarizationModel: '',
  }), /fallback summarization provider and model must be set together/)

  assert.throws(() => engine.applyRuntimeConfig({
    summarizationProvider: 'openai',
    summarizationModel: 'same',
    fallbackSummarizationProvider: 'openai',
    fallbackSummarizationModel: 'same',
  }), /fallback summarization route must differ/)
}))

test('atomic dedicated summarizer route applies live and blank changes are ignored', async () => withSettingsEngine(async ({ engine, commitConfig }) => {
  commitConfig({
    summarizationProvider: '  openai  ',
    summarizationModel: '  gpt-5.6-sol  ',
    fallbackSummarizationProvider: '  anthropic  ',
    fallbackSummarizationModel: '  claude-sonnet  ',
    tailCount: 31,
    minRetainTokens: 36000,
  })

  assert.equal(engine.config.summarizationProvider, 'openai')
  assert.equal(engine.config.summarizationModel, 'gpt-5.6-sol')
  assert.deepEqual(engine.fallbackSummarizationRoute, { provider: 'anthropic', model: 'claude-sonnet' })
  assert.equal(engine.rollingConfig.tailCount, 31)
  assert.equal(engine.rollingConfig.minRetainTokens, 36000)

  commitConfig({
    summarizationProvider: 'anthropic',
    summarizationModel: 'claude-opus-5',
    fallbackSummarizationProvider: 'anthropic',
    fallbackSummarizationModel: 'claude-sonnet',
    tailCount: 31,
    minRetainTokens: 36000,
  })

  assert.equal(engine.config.summarizationProvider, 'anthropic')
  assert.equal(engine.config.summarizationModel, 'claude-opus-5')
  assert.deepEqual(engine.fallbackSummarizationRoute, { provider: 'anthropic', model: 'claude-sonnet' })

  commitConfig({
    summarizationProvider: 'anthropic',
    summarizationModel: 'claude-opus-5',
    fallbackSummarizationProvider: '',
    fallbackSummarizationModel: '',
    tailCount: 31,
    minRetainTokens: 36000,
  })
  assert.deepEqual(engine.fallbackSummarizationRoute, { provider: '', model: '' })

  // 主路由清空：applyRuntimeConfig 直接调用仍拒绝（单元层）。
  assert.throws(() => engine.applyRuntimeConfig({
    summarizationProvider: '',
    summarizationModel: '',
    fallbackSummarizationProvider: '',
    fallbackSummarizationModel: '',
    tailCount: 31,
    minRetainTokens: 36000,
  }), /requires an explicit summarization provider and model/)

  assert.equal(engine.config.summarizationProvider, 'anthropic')
  assert.equal(engine.config.summarizationModel, 'claude-opus-5')
}))
