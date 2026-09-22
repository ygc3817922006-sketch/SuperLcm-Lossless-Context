const stubs = new Map([
  ['@deepseek-ai/dsh-tools', `
export function defineTool(definition) { return definition }
`],
  ['@deepseek-ai/dsh-compaction-basic', `
export class BasicCompactionEngine {
  constructor(ctx, config = {}) {
    this.ctx = ctx; this.config = config
    if (typeof this._registerAutomaticCompaction === 'function') this._registerAutomaticCompaction()
  }
  async summarize(input) {
    const provider = this.config?.summarizationProvider ?? ''
    const model = this.config?.summarizationModel ?? ''
    if (Array.isArray(input?.routeAttempts)) input.routeAttempts.push({ provider, model })
    if (input?.throwFromBase || input?.failProviders?.includes(provider)) throw new Error('base summary failed for ' + provider + '/' + model)
    return { summary: [{ type: 'text', text: input?.baseText ?? 'base checkpoint' }], tokenCount: 7, provider, model }
  }
  compactNow(agent, signal, sourceCommandId) {
    return Promise.resolve({ agent, signal, sourceCommandId, delegated: true })
  }
}
export default BasicCompactionEngine
`],
  ['@deepseek-ai/dsh-llm', `
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export function createUserMessage(data) { return data }
export function errorChain(error) { return [{ message: error instanceof Error ? error.message : String(error) }] }
`],
  ['@deepseek-ai/schemastery', `
function node() {
  const self = {
    _default: undefined,
    _volatile: false,
    default(value) { self._default = value; return self },
    min() { return self },
    max() { return self },
    step() { return self },
    volatile() { self._volatile = true; return self },
  }
  return self
}
export default {
  object(dict) { const n = node(); n._dict = dict; return n },
  string() { return node() },
  number() { return node() },
  percent() { return node() },
  union(list) { const n = node(); n._list = list; return n },
  const(value) { const n = node(); n._value = value; return n },
  array(inner) { const n = node(); n._inner = inner; return n },
  boolean() { return node() },
  intersect(list) { const n = node(); n._list = list; return n },
}
`],
  ['@deepseek-ai/dsh-compaction', `
export function toolPairingBalancedBefore() { return true }
export function toolPairingBalancedAfter() { return true }
export function compactCheckpointSource(compactionId) { return { kind: 'plugin', plugin: 'compact', compactionId } }
export function isCompactCheckpointSource(source) { return source?.kind === 'plugin' && source?.plugin === 'compact' }
export const ManualCompactionError = class ManualCompactionError extends Error {}
export const CompactionId = (value) => value
`],
])

export async function resolve(specifier, context, nextResolve) {
  const source = stubs.get(specifier)
  if (source === undefined) return nextResolve(specifier, context)
  return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
}
