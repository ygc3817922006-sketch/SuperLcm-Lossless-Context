import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { indexCompactionEvent } from './core.js'
import { appendRecallEnvelope, extractChildNodeIds } from './marker.js'
import { selectRollingRange } from './rolling.js'
import { SuperLcmStore, resolveDatabasePath } from './store.js'
import {
  AsyncSurfaceChangedError,
  commitAsyncRegion,
  prepareAsyncRegion,
  summarizeAsyncRegion,
} from './async-region.js'

const ROLLING_CONFIG_KEYS = new Set([
  'mode',
  'tailCount',
  'minRetainTokens',
  'pressureFoldTokens',
  'foldBatchTokens',
  'softActiveTokens',
  'hardActiveTokens',
  'cacheTtlSeconds',
  'foldTiming',
])

const ROLLING_DEFAULTS = Object.freeze({
  mode: 'rolling',
  tailCount: 24,
  minRetainTokens: 32000,
  pressureFoldTokens: 20000,
  foldBatchTokens: 64000,
  softActiveTokens: 160000,
  hardActiveTokens: 220000,
  foldTiming: 'background',
})

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeRolling(config) {
  const raw = config ?? {}
  if (raw.foldTiming !== undefined && raw.foldTiming !== 'background') {
    throw new Error('SuperLcm only supports non-blocking background automatic compaction')
  }
  if (raw.mode !== undefined && raw.mode !== 'rolling') {
    throw new Error('SuperLcm only supports rolling mode because automatic compaction must remain non-blocking')
  }
  const mode = 'rolling'
  const foldBatchTokens = positiveInteger(raw.foldBatchTokens, ROLLING_DEFAULTS.foldBatchTokens)
  const pressureFoldTokens = Math.min(
    positiveInteger(raw.pressureFoldTokens, ROLLING_DEFAULTS.pressureFoldTokens),
    foldBatchTokens,
  )
  const softActiveTokens = positiveInteger(raw.softActiveTokens, ROLLING_DEFAULTS.softActiveTokens)
  const requestedHardActiveTokens = positiveInteger(raw.hardActiveTokens, ROLLING_DEFAULTS.hardActiveTokens)
  const hardActiveTokens = requestedHardActiveTokens > softActiveTokens
    ? requestedHardActiveTokens
    : softActiveTokens + 1

  return {
    mode,
    tailCount: positiveInteger(raw.tailCount, ROLLING_DEFAULTS.tailCount),
    minRetainTokens: nonNegativeInteger(raw.minRetainTokens, ROLLING_DEFAULTS.minRetainTokens),
    pressureFoldTokens,
    foldBatchTokens,
    softActiveTokens,
    hardActiveTokens,
    foldTiming: ROLLING_DEFAULTS.foldTiming,
  }
}

function cleanRouteValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanRoute(route) {
  return {
    provider: cleanRouteValue(route?.provider),
    model: cleanRouteValue(route?.model),
  }
}

function routeIsComplete(route) {
  return (route.provider.length === 0) === (route.model.length === 0)
}

const SETTINGS_NAMESPACE = 'superlcm'
const SUMMARIZATION_ROUTE_SCHEMA = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
}).default({ provider: '', model: '' })

const SETTINGS_SCHEMA = z.object({
  summarizationRoute: SUMMARIZATION_ROUTE_SCHEMA,
  tailCount: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.tailCount),
  minRetainTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.minRetainTokens),
  pressureFoldTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.pressureFoldTokens),
  foldBatchTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.foldBatchTokens),
  softActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.softActiveTokens),
  hardActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.hardActiveTokens),
  foldTiming: z.const('background').default(ROLLING_DEFAULTS.foldTiming),
  thresholdRatio: z.percent().default(0.6),
  retainRatio: z.percent().default(0.16),
})

function splitConfig(config) {
  const base = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!ROLLING_CONFIG_KEYS.has(key)) base[key] = value
  }
  return { base, rolling: normalizeRolling(config) }
}

function compactedInputOf(input) {
  if (input === null || typeof input !== 'object') return input
  return input.messages
    ?? input.shadowedMessages
    ?? input.history
    ?? input
}

function systemPrefixEndIndex(session) {
  const surfaceNodes = session?.surface?.nodes
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return 0
  const head = typeof session.eventAt === 'function' ? session.eventAt(surfaceNodes[0]) : undefined
  return head?.type === 'system/message' ? 1 : 0
}

function isFrozenCheckpoint(event) {
  return event?.type === 'user/message'
    && isCompactCheckpointSource(event.data?.source)
    && extractChildNodeIds(event.data?.content).length > 0
}

function firstFoldableSurfaceIndex(session) {
  const surfaceNodes = session?.surface?.nodes
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return 0
  let index = systemPrefixEndIndex(session)
  if (typeof session.eventAt !== 'function') return index
  while (index < surfaceNodes.length && isFrozenCheckpoint(session.eventAt(surfaceNodes[index]))) index += 1
  return index
}

function reportIndexFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.warn(`[SuperLcm] 已提交的压缩索引失败 / failed to index committed compaction: ${message}`)
}

export class SuperLcmCompactionEngine extends BasicCompactionEngine {
  constructor(ctx, config = {}) {
    const { base, rolling } = splitConfig(config)
    super(ctx, base)
    this.rollingConfig = rolling
    this.superLcmStore = new SuperLcmStore(resolveDatabasePath())
    this.backgroundFolds = new WeakMap()
    this.backgroundControllers = new Set()
    this.warnedMissingBackgroundRoute = false
    this.superlcmStore = this.superLcmStore
    // 兼容 dsh-lossless-context <= 0.2.x 的旧属性 / Compatibility property for dsh-lossless-context <= 0.2.x.
    this.losslessStore = this.superLcmStore
    ctx.effect(() => () => {
      for (const controller of this.backgroundControllers) controller.abort(new Error('SuperLcm disposed'))
      this.backgroundControllers.clear()
      this.superLcmStore.close()
    })

    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'compaction/summary') return
      try {
        indexCompactionEvent(this.superLcmStore, session, event)
      } catch (error) {
        reportIndexFailure(error)
      }
    })

    this.installSettingsSection(ctx)
  }

  installSettingsSection(ctx) {
    const entry = {
      summarizationRoute: cleanRoute({
        provider: this.config?.summarizationProvider,
        model: this.config?.summarizationModel,
      }),
      tailCount: this.rollingConfig.tailCount,
      minRetainTokens: this.rollingConfig.minRetainTokens,
      pressureFoldTokens: this.rollingConfig.pressureFoldTokens,
      foldBatchTokens: this.rollingConfig.foldBatchTokens,
      softActiveTokens: this.rollingConfig.softActiveTokens,
      hardActiveTokens: this.rollingConfig.hardActiveTokens,
      foldTiming: this.rollingConfig.foldTiming,
      thresholdRatio: this.config?.thresholdRatio ?? 0.6,
      retainRatio: this.config?.retainRatio ?? 0.16,
    }
    let source = () => entry
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, entry, {
          validate: (value) => {
            const route = cleanRoute(value.summarizationRoute)
            if (!routeIsComplete(route) || route.provider.length === 0) {
              throw new Error('background compaction requires an explicit summarization provider and model')
            }
            if (value.retainRatio >= value.thresholdRatio) {
              throw new Error(`retainRatio (${value.retainRatio}) must be less than thresholdRatio (${value.thresholdRatio})`)
            }
            if (value.pressureFoldTokens > value.foldBatchTokens) {
              throw new Error(`pressureFoldTokens (${value.pressureFoldTokens}) must not exceed foldBatchTokens (${value.foldBatchTokens})`)
            }
            if (value.hardActiveTokens <= value.softActiveTokens) {
              throw new Error(`hardActiveTokens (${value.hardActiveTokens}) must be greater than softActiveTokens (${value.softActiveTokens})`)
            }
          },
          setSource: (current) => {
            source = current
          },
          onChange: () => {
            const value = source()
            const route = cleanRoute(value.summarizationRoute)
            if (!routeIsComplete(route) || route.provider.length === 0) return

            this.rollingConfig = normalizeRolling({
              ...this.rollingConfig,
              tailCount: value.tailCount,
              minRetainTokens: value.minRetainTokens,
              pressureFoldTokens: value.pressureFoldTokens,
              foldBatchTokens: value.foldBatchTokens,
              softActiveTokens: value.softActiveTokens,
              hardActiveTokens: value.hardActiveTokens,
              foldTiming: value.foldTiming,
            })
            const thresholdRatio = value.thresholdRatio
            const retainRatio = value.retainRatio
            if (retainRatio >= thresholdRatio) return
            const nextConfig = {
              ...this.config,
              summarizationProvider: route.provider,
              summarizationModel: route.model,
              thresholdRatio,
              retainRatio,
            }
            delete nextConfig.retainTokens
            this.config = nextConfig
          },
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[SuperLcm] 设置区域不可用 / settings section unavailable: ${message}`)
    }
  }

  async summarize(...args) {
    const input = args[0]
    const children = extractChildNodeIds(compactedInputOf(input))
    const result = await super.summarize(...args)
    if (result === null || typeof result !== 'object' || !Array.isArray(result.summary)) {
      throw new TypeError('BasicCompactionEngine.summarize() returned an invalid summary result')
    }

    const nodeId = randomUUID()
    return {
      ...result,
      summary: appendRecallEnvelope(result.summary, { id: nodeId, children }),
    }
  }

  _registerAutomaticCompaction() {
    if (this.rollingConfig === undefined) {
      queueMicrotask(() => this._registerAutomaticCompaction())
      return
    }
    if (this.rollingConfig.mode !== 'rolling') return super._registerAutomaticCompaction()
    this._registerRollingPressure()
    this._registerOverflowRecovery()
  }

  _registerRollingPressure() {
    const { ctx } = this
    ctx.on('agent/pre-step', ({ agent, signal }, next) => {
      if (signal.aborted) return next()
      this.tryCommitBackgroundFold(agent, { allowPressure: true })
      if (this.backgroundFolds.has(agent)) return next()

      try {
        const selection = this.planRolling(agent)
        if (selection !== null) this.startBackgroundFold(agent, selection)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`rolling selection failed: ${message}; continuing the turn`)
      }
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.tryCommitBackgroundFold(agent)
    })
  }

  backgroundRouteConfigured() {
    const provider = cleanRouteValue(this.config?.summarizationProvider)
    const model = cleanRouteValue(this.config?.summarizationModel)
    if (provider.length > 0 && model.length > 0) return true
    if (!this.warnedMissingBackgroundRoute) {
      this.warnedMissingBackgroundRoute = true
      this.ctx.logger?.warn?.('SuperLcm background compaction requires an explicit summarizationRoute; refusing to fall back to the conversation model')
    }
    return false
  }

  prepareBackgroundSelection(agent, selection) {
    return prepareAsyncRegion(this, agent, selection)
  }

  summarizeBackgroundSelection(agent, prepared, signal) {
    return summarizeAsyncRegion(this, agent, prepared, signal)
  }

  commitBackgroundSelection(agent, summarized) {
    const result = commitAsyncRegion(this, agent, summarized)
    return result === null ? null : { ...result, rollingPolicy: summarized }
  }

  startBackgroundFold(agent, selection) {
    if (this.backgroundFolds.has(agent) || !this.backgroundRouteConfigured()) return false
    let prepared
    try {
      prepared = this.prepareBackgroundSelection(agent, selection)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(`rolling compaction staging failed: ${message}; continuing`)
      return false
    }

    const controller = new AbortController()
    const state = { status: 'summarizing', selection, prepared, controller, promise: null, summarized: null }
    this.backgroundFolds.set(agent, state)
    this.backgroundControllers.add(controller)
    state.promise = this.summarizeBackgroundSelection(agent, prepared, controller.signal)
      .then((summarized) => {
        if (this.backgroundFolds.get(agent) !== state) return
        state.summarized = summarized
        state.status = 'ready'
      })
      .catch((error) => {
        if (this.backgroundFolds.get(agent) === state) this.backgroundFolds.delete(agent)
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`rolling compaction background summary failed: ${message}; continuing`)
      })
      .finally(() => this.backgroundControllers.delete(controller))
    return true
  }

  tryCommitBackgroundFold(agent, options = {}) {
    const state = this.backgroundFolds.get(agent)
    if (state?.status !== 'ready') return null
    if (options.force !== true && state.selection.reason === 'background-batch') {
      const activeTokens = options.allowPressure === true
        ? this.ctx.tokenMeter.measure(agent.session).totalTokens
        : 0
      if (activeTokens < this.rollingConfig.softActiveTokens) return null
    }
    try {
      const result = this.commitBackgroundSelection(agent, state.summarized)
      if (result === null) return null
      this.backgroundFolds.delete(agent)
      this.logFoldResult(this.ctx, result)
      return result
    } catch (error) {
      this.backgroundFolds.delete(agent)
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AsyncSurfaceChangedError) {
        this.ctx.logger?.info?.(`rolling compaction prepared span changed; restaging later: ${message}`)
      } else {
        this.ctx.logger?.warn?.(`rolling compaction commit failed: ${message}; continuing`)
      }
      return null
    }
  }

  async settleBackgroundFold(agent) {
    const state = this.backgroundFolds.get(agent)
    if (state?.promise !== null && state?.promise !== undefined) await state.promise
  }

  logFoldResult(ctx, result) {
    if (result !== null && typeof result === 'object' && Array.isArray(result.shadowedSeqs)) {
      const policy = result.rollingPolicy
      const detail = policy === undefined
        ? ''
        : `, reason=${policy.reason}, active~${policy.activeTokens}, tail~${policy.tailTokens}`
      ctx.logger?.info?.(
        `compaction (rolling): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens${detail})`,
      )
    }
  }

  _registerOverflowRecovery() {
    const { ctx } = this
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== void 0) this.overflowRetries.delete(agent)
    })
    ctx.on('agent/request-error', ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= (this.config?.maxOverflowRetries ?? 1)) return next()
      const generation = agent.session.surface.replaceGeneration
      const result = this.tryCommitBackgroundFold(agent, { force: true })
      if (result !== null && agent.session.surface.replaceGeneration > generation) {
        this.overflowRetries.set(agent, retries + 1)
        return { kind: 'retry' }
      }
      if (!this.backgroundFolds.has(agent)) {
        try {
          const selection = this.planRolling(agent, false)
          if (selection !== null) this.startBackgroundFold(agent, selection)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`context-overflow background staging failed: ${message}`)
        }
      }
      ctx.logger?.warn?.('context overflow reached before the background summary was ready; preserving the request error without blocking')
      return next()
    })
  }

  planRolling(agent) {
    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    const options = {
      tailCount: this.rollingConfig.tailCount,
      minRetainTokens: this.rollingConfig.minRetainTokens,
      pressureFoldTokens: this.rollingConfig.pressureFoldTokens,
      foldBatchTokens: this.rollingConfig.foldBatchTokens,
      softActiveTokens: this.rollingConfig.softActiveTokens,
      hardActiveTokens: this.rollingConfig.hardActiveTokens,
      activeTokens: measurement.totalTokens,
      firstFoldableIndex: firstFoldableSurfaceIndex(session),
      isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
    }
    const selection = selectRollingRange(measurement.nodes, session.surface.nodes, options)
    if (selection !== null || measurement.totalTokens < this.rollingConfig.hardActiveTokens) return selection
    const systemEnd = systemPrefixEndIndex(session)
    if (options.firstFoldableIndex <= systemEnd) return null
    return selectRollingRange(measurement.nodes, session.surface.nodes, { ...options, firstFoldableIndex: systemEnd })
  }

  async commitRollingSelection(agent, selection) {
    this.startBackgroundFold(agent, selection)
    return null
  }

  async rollingMaintain(agent, _signal) {
    const selection = this.planRolling(agent)
    if (selection === null) return null
    this.startBackgroundFold(agent, selection)
    return null
  }

  async compactNow(agent, signal) {
    if (signal?.aborted) return null
    return this.rollingMaintain(agent, signal)
  }
}

// 兼容旧版 SuperLcm、SuperLCM 与 dsh-lossless-context <= 0.2.x 的导出 / Compatibility exports for older SuperLcm, SuperLCM, and dsh-lossless-context <= 0.2.x.
export { SuperLcmCompactionEngine as SuperLCMCompactionEngine }
export { SuperLcmCompactionEngine as LosslessCompactionEngine }
export default SuperLcmCompactionEngine