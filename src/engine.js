import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { indexCompactionEvent } from './core.js'
import { appendRecallEnvelope, extractChildNodeIds } from './marker.js'
import { selectRollingRange } from './rolling.js'
import { LosslessStore, resolveDatabasePath } from './store.js'

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
  cacheTtlSeconds: 1800,
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
  const mode = raw.mode === 'threshold' ? 'threshold' : 'rolling'
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
    cacheTtlSeconds: nonNegativeInteger(raw.cacheTtlSeconds, ROLLING_DEFAULTS.cacheTtlSeconds),
    foldTiming: raw.foldTiming === 'sync' ? 'sync' : ROLLING_DEFAULTS.foldTiming,
  }
}

const SETTINGS_NAMESPACE = 'lossless-context'

const SETTINGS_SCHEMA = z.object({
  tailCount: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.tailCount),
  minRetainTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.minRetainTokens),
  pressureFoldTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.pressureFoldTokens),
  foldBatchTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.foldBatchTokens),
  softActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.softActiveTokens),
  hardActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.hardActiveTokens),
  cacheTtlSeconds: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.cacheTtlSeconds),
  foldTiming: z.union([z.const('background'), z.const('sync')]).default(ROLLING_DEFAULTS.foldTiming),
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

function reportIndexFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.warn(`[dsh-lossless-context] failed to index committed compaction: ${message}`)
}

/**
 * DSH-native Lossless Context Management backend.
 *
 * It inherits transaction, retention, cancellation, convergence and
 * surface-replacement behavior from the official BasicCompactionEngine.
 * `summarize()` remains the only summary seam. Rolling mode changes only when
 * a head span is admitted for that official transaction:
 *
 * - keep a recent verbatim tail by BOTH node count and token budget;
 * - defer routine prefix mutation while the model cache is likely hot;
 * - compact opportunistically after cache expiry when the old head reaches a
 *   larger batch;
 * - override cache deferral at soft/hard active-context pressure;
 * - force pressure folds synchronously so the active-context caps do not rely
 *   on speculative background timing.
 */
export class LosslessCompactionEngine extends BasicCompactionEngine {
  constructor(ctx, config = {}) {
    const { base, rolling } = splitConfig(config)
    super(ctx, base)
    this.rollingConfig = rolling
    this.losslessStore = new LosslessStore(resolveDatabasePath())
    ctx.effect(() => () => this.losslessStore.close())

    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'compaction/summary') return
      try {
        indexCompactionEvent(this.losslessStore, session, event)
      } catch (error) {
        reportIndexFailure(error)
      }
    })

    this.installSettingsSection(ctx, base)
  }

  /**
   * Expose rolling tunables to the host settings service. The current web card
   * renders the common fields; advanced cache/pressure fields remain available
   * through the resolved settings document and host configuration.
   */
  installSettingsSection(ctx, base) {
    const entry = {
      tailCount: this.rollingConfig.tailCount,
      minRetainTokens: this.rollingConfig.minRetainTokens,
      pressureFoldTokens: this.rollingConfig.pressureFoldTokens,
      foldBatchTokens: this.rollingConfig.foldBatchTokens,
      softActiveTokens: this.rollingConfig.softActiveTokens,
      hardActiveTokens: this.rollingConfig.hardActiveTokens,
      cacheTtlSeconds: this.rollingConfig.cacheTtlSeconds,
      foldTiming: this.rollingConfig.foldTiming,
      thresholdRatio: base.thresholdRatio,
      retainRatio: base.retainRatio,
    }
    let source = () => entry
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, entry, {
          validate: (value) => {
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
            this.rollingConfig = normalizeRolling({
              ...this.rollingConfig,
              tailCount: value.tailCount,
              minRetainTokens: value.minRetainTokens,
              pressureFoldTokens: value.pressureFoldTokens,
              foldBatchTokens: value.foldBatchTokens,
              softActiveTokens: value.softActiveTokens,
              hardActiveTokens: value.hardActiveTokens,
              cacheTtlSeconds: value.cacheTtlSeconds,
              foldTiming: value.foldTiming,
            })
            const thresholdRatio = value.thresholdRatio
            const retainRatio = value.retainRatio
            if (retainRatio >= thresholdRatio) return
            const nextConfig = { ...this.config, thresholdRatio, retainRatio }
            delete nextConfig.retainTokens
            this.config = nextConfig
          },
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[dsh-lossless-context] settings section unavailable: ${message}`)
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

  currentTimeMs() {
    return Date.now()
  }

  cacheHotFor(agent) {
    this.lastPreStepAt ??= new WeakMap()
    const now = this.currentTimeMs()
    const previous = this.lastPreStepAt.get(agent)
    this.lastPreStepAt.set(agent, now)
    const ttlMs = this.rollingConfig.cacheTtlSeconds * 1000
    if (ttlMs <= 0) return false
    if (previous === undefined) return true
    return now - previous < ttlMs
  }

  _registerRollingPressure() {
    const { ctx } = this
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (signal.aborted) return next()
      await this.settleBackgroundFold(agent)
      if (signal.aborted) return next()

      const cacheHot = this.cacheHotFor(agent)
      let selection
      try {
        selection = this.planRolling(agent, cacheHot)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`rolling selection failed: ${message}; continuing the turn`)
        return next()
      }
      if (selection === null) return next()

      if (this.rollingConfig.foldTiming === 'background' && selection.reason === 'cold-batch') {
        this.startBackgroundFold(agent, selection, signal)
        return next()
      }

      try {
        const result = await this.commitRollingSelection(agent, selection, signal)
        this.logFoldResult(ctx, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`rolling compaction failed: ${message}; continuing the turn`)
      }
      return next()
    })
  }

  async settleBackgroundFold(agent) {
    const pending = this.backgroundFolds?.get(agent)
    if (pending !== undefined) await pending
  }

  startBackgroundFold(agent, selection, signal) {
    this.backgroundFolds ??= new Map()
    const fold = this.commitRollingSelection(agent, selection, signal)
      .then((result) => {
        this.backgroundFolds.delete(agent)
        this.logFoldResult(this.ctx, result)
      })
      .catch((error) => {
        this.backgroundFolds.delete(agent)
        if (signal?.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`rolling compaction (background) failed: ${message}; continuing`)
      })
    this.backgroundFolds.set(agent, fold)
  }

  logFoldResult(ctx, result) {
    if (result !== null && typeof result === 'object' && Array.isArray(result.shadowedSeqs)) {
      const policy = result.rollingPolicy
      const detail = policy === undefined
        ? ''
        : `, reason=${policy.reason}, active~${policy.activeTokens}, tail~${policy.tailTokens}, cache=${policy.cacheHot ? 'hot' : 'cold'}`
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
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= (this.config?.maxOverflowRetries ?? 1)) return next()
      const generation = agent.session.surface.replaceGeneration
      let result
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger?.warn?.('context-overflow compaction failed after durable surface progress; retrying from the replacement surface')
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger?.warn?.(`context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) ctx.logger?.info?.('compaction (context overflow recovery): completed')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  planRolling(agent, cacheHot = false) {
    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    return selectRollingRange(measurement.nodes, session.surface.nodes, {
      tailCount: this.rollingConfig.tailCount,
      minRetainTokens: this.rollingConfig.minRetainTokens,
      pressureFoldTokens: this.rollingConfig.pressureFoldTokens,
      foldBatchTokens: this.rollingConfig.foldBatchTokens,
      softActiveTokens: this.rollingConfig.softActiveTokens,
      hardActiveTokens: this.rollingConfig.hardActiveTokens,
      activeTokens: measurement.totalTokens,
      cacheHot,
      isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
    })
  }

  async commitRollingSelection(agent, selection, signal) {
    const result = await this.compactRegion(selection.start, selection.end, agent, signal)
    return { ...result, rollingPolicy: selection }
  }

  async rollingMaintain(agent, signal, options = {}) {
    const selection = this.planRolling(agent, options.cacheHot === true)
    if (selection === null) return null
    return this.commitRollingSelection(agent, selection, signal)
  }
}

export default LosslessCompactionEngine
