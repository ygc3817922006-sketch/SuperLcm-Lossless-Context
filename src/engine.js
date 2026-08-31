import { randomUUID } from 'node:crypto'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { indexCompactionEvent } from './core.js'
import { appendRecallEnvelope, extractChildNodeIds } from './marker.js'
import { LosslessStore, resolveDatabasePath } from './store.js'

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
 * only overridden seam is summarize(): every checkpoint receives a stable node
 * marker and edges to checkpoint markers found in the compacted span.
 */
export class LosslessCompactionEngine extends BasicCompactionEngine {
  constructor(ctx, config = {}) {
    super(ctx, config)
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
}

export default LosslessCompactionEngine
