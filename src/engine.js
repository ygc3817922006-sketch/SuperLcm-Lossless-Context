import { randomUUID } from 'node:crypto'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { indexCompactionEvent } from './core.js'
import { appendRecallEnvelope, extractChildNodeIds } from './marker.js'
import { selectRollingRange } from './rolling.js'
import { LosslessStore, resolveDatabasePath } from './store.js'

const ROLLING_CONFIG_KEYS = new Set(['mode', 'tailCount', 'foldBatchTokens'])
const ROLLING_DEFAULTS = Object.freeze({ mode: 'rolling', tailCount: 24, foldBatchTokens: 20000 })

function normalizeRolling(config) {
  const raw = config ?? {}
  const mode = raw.mode === 'threshold' ? 'threshold' : 'rolling'
  return {
    mode,
    tailCount: Number.isSafeInteger(raw.tailCount) && raw.tailCount > 0 ? raw.tailCount : ROLLING_DEFAULTS.tailCount,
    foldBatchTokens: Number.isSafeInteger(raw.foldBatchTokens) && raw.foldBatchTokens > 0
      ? raw.foldBatchTokens
      : ROLLING_DEFAULTS.foldBatchTokens,
  }
}

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
 * It inherits transaction, pressure, retention, cancellation, convergence and
 * surface-replacement behavior from the official BasicCompactionEngine. The
 * overridden seams are summarize() (stable node markers and DAG edges) and the
 * automatic trigger policy:
 *
 * - mode "rolling" (default): lossless-claw style steady-state maintenance.
 *   Every agent step keeps a fresh verbatim tail of tailCount surface nodes
 *   and folds the older head into the running summary once it exceeds
 *   foldBatchTokens. Repeated folds chain summary markers into a multi-level
 *   recall DAG, and the active surface never crosses the budget.
 * - mode "threshold": the official one-shot behavior — compaction fires once
 *   when measured tokens cross thresholdRatio of the model window.
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

  /**
   * Swap the official automatic trigger policy for the rolling one. The
   * official context-overflow recovery (fold on provider context-window
   * errors, then retry the request) is preserved unchanged.
   */
  _registerAutomaticCompaction() {
    if (this.rollingConfig === undefined) {
      // The base constructor invokes this hook during super(), before subclass
      // field initializers have run, so `rollingConfig` is not assigned yet.
      // Re-enqueue the registration as a microtask: it fires after the
      // synchronous constructor completes, when all fields are set. Semantics
      // are unchanged — the base auto-trigger policy is still replaced.
      queueMicrotask(() => this._registerAutomaticCompaction())
      return
    }
    if (this.rollingConfig.mode !== 'rolling') return super._registerAutomaticCompaction()
    this._registerRollingPressure()
    this._registerOverflowRecovery()
  }

  _registerRollingPressure() {
    const { ctx } = this
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) try {
        const result = await this.rollingMaintain(agent, signal)
        if (result !== null && typeof result === 'object' && Array.isArray(result.shadowedSeqs)) {
          ctx.logger?.info?.(`compaction (rolling): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`rolling compaction failed: ${message}; continuing the turn`)
      }
      return next()
    })
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

  /**
   * One rolling maintenance pass: keep the configured fresh tail verbatim and
   * fold the older head into the running summary when it exceeds the batch
   * floor. Uses the official transactional compactRegion so durability,
   * compaction locks, replay validation and the summarizer hook stay identical
   * to the built-in engine.
   */
  async rollingMaintain(agent, signal) {
    const session = agent.session
    const meter = this.ctx.tokenMeter
    const measurement = meter.measure(session)
    const selection = selectRollingRange(measurement.nodes, session.surface.nodes, {
      tailCount: this.rollingConfig.tailCount,
      foldBatchTokens: this.rollingConfig.foldBatchTokens,
      isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
    })
    if (selection === null) return null
    return this.compactRegion(selection.start, selection.end, agent, signal)
  }
}

export default LosslessCompactionEngine
