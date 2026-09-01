/**
 * Rolling-mode surface selection for the lossless compaction engine.
 *
 * The rolling policy keeps a fresh verbatim tail (by surface-node count, the
 * equivalent of lossless-claw's `freshTailCount`) and folds everything older
 * into the running summary once the foldable head exceeds a batch floor. The
 * head span includes previously committed summaries, so repeated folds chain
 * summary markers into the multi-level recall DAG.
 */

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function tokenCountOf(node) {
  return Number.isFinite(node?.tokens) ? node.tokens : 0
}

/**
 * Select the head span to fold so that at least `tailCount` recent surface
 * nodes (and, when provided, `minRetainTokens` recent tokens) stay verbatim.
 * Returns `null` while the foldable head is below the batch floor, which is
 * the hysteresis that keeps rolling maintenance from running every step.
 * @param pricedNodes - token-meter surface measurement nodes (`{ seq, tokens }`).
 * @param surfaceSeqs - current surface node seqs, aligned with `pricedNodes`.
 * @param options - `tailCount`, `foldBatchTokens`, optional `minRetainTokens`
 *   and `isBalancedBefore(seq)` tool-pairing predicate.
 * @returns `{ start, end, foldTokens, tailNodes }` or `null`.
 */
export function selectRollingRange(pricedNodes, surfaceSeqs, options = {}) {
  const tailCount = positiveInteger(options.tailCount, 24)
  const foldBatchTokens = positiveInteger(options.foldBatchTokens, 20000)
  const minRetainTokens = positiveInteger(options.minRetainTokens, 0)
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  if (!Array.isArray(surfaceSeqs) || surfaceSeqs.length !== pricedNodes.length) {
    throw new Error('rolling selection: token-meter surface does not match the current session surface')
  }
  let keepFromIdx = pricedNodes.length
  let keptNodes = 0
  let keptTokens = 0
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    keepFromIdx = index
    keptNodes += 1
    keptTokens += tokenCountOf(pricedNodes[index])
    if (keptNodes >= tailCount && keptTokens >= minRetainTokens) break
  }
  while (keepFromIdx > 0 && !(options.isBalancedBefore?.(surfaceSeqs[keepFromIdx]) ?? true)) {
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null
  let foldTokens = 0
  for (let index = 0; index < keepFromIdx; index += 1) foldTokens += tokenCountOf(pricedNodes[index])
  if (foldTokens < foldBatchTokens) return null
  return {
    start: surfaceSeqs[0],
    end: surfaceSeqs[keepFromIdx - 1],
    foldTokens,
    tailNodes: pricedNodes.length - keepFromIdx,
  }
}
