/**
 * Rolling-mode surface selection for the lossless compaction engine.
 *
 * The cache-aware policy keeps a fresh verbatim tail by both surface-node
 * count and token budget. Routine mutations wait for a larger cold-cache
 * commit batch; active-context pressure can override that delay with a smaller
 * useful fold, and the hard cap always wins.
 */

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function tokenCountOf(node) {
  return Number.isFinite(node?.tokens) ? node.tokens : 0
}

function totalTokenCount(nodes) {
  return nodes.reduce((total, node) => total + tokenCountOf(node), 0)
}

function tailBoundary(pricedNodes, surfaceSeqs, options) {
  let keepFromIdx = pricedNodes.length
  let keptNodes = 0
  let keptTokens = 0

  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    keepFromIdx = index
    keptNodes += 1
    keptTokens += tokenCountOf(pricedNodes[index])
    if (keptNodes >= options.tailCount && keptTokens >= options.minRetainTokens) break
  }

  while (keepFromIdx > 0 && !(options.isBalancedBefore?.(surfaceSeqs[keepFromIdx]) ?? true)) {
    keepFromIdx -= 1
    keptNodes += 1
    keptTokens += tokenCountOf(pricedNodes[keepFromIdx])
  }

  return { keepFromIdx, keptNodes, keptTokens }
}

export function selectRollingRange(pricedNodes, surfaceSeqs, options = {}) {
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  if (!Array.isArray(surfaceSeqs) || surfaceSeqs.length !== pricedNodes.length) {
    throw new Error('rolling selection: token-meter surface does not match the current session surface')
  }

  const tailCount = positiveInteger(options.tailCount, 24)
  const minRetainTokens = nonNegativeInteger(options.minRetainTokens, 32000)
  const foldBatchTokens = positiveInteger(options.foldBatchTokens, 64000)
  const pressureFoldTokens = Math.min(
    positiveInteger(options.pressureFoldTokens, 20000),
    foldBatchTokens,
  )
  const softActiveTokens = positiveInteger(options.softActiveTokens, 160000)
  const hardActiveTokens = Math.max(
    positiveInteger(options.hardActiveTokens, 220000),
    softActiveTokens + 1,
  )
  const activeTokens = nonNegativeInteger(options.activeTokens, totalTokenCount(pricedNodes))
  const cacheHot = options.cacheHot === true
  const hardPressure = activeTokens >= hardActiveTokens

  let boundary = tailBoundary(pricedNodes, surfaceSeqs, {
    tailCount,
    minRetainTokens,
    isBalancedBefore: options.isBalancedBefore,
  })

  let tailCountRelaxed = false
  if (boundary.keepFromIdx === 0 && hardPressure && tailCount > 1) {
    boundary = tailBoundary(pricedNodes, surfaceSeqs, {
      tailCount: 1,
      minRetainTokens,
      isBalancedBefore: options.isBalancedBefore,
    })
    tailCountRelaxed = boundary.keepFromIdx > 0
  }
  if (boundary.keepFromIdx === 0) return null

  let foldTokens = 0
  for (let index = 0; index < boundary.keepFromIdx; index += 1) {
    foldTokens += tokenCountOf(pricedNodes[index])
  }
  if (foldTokens <= 0) return null

  let reason
  if (hardPressure) {
    reason = 'hard-cap'
  } else if (activeTokens >= softActiveTokens && foldTokens >= pressureFoldTokens) {
    reason = 'soft-cap'
  } else if (!cacheHot && foldTokens >= foldBatchTokens) {
    reason = 'cold-batch'
  } else {
    return null
  }

  return {
    start: surfaceSeqs[0],
    end: surfaceSeqs[boundary.keepFromIdx - 1],
    foldTokens,
    tailNodes: pricedNodes.length - boundary.keepFromIdx,
    tailTokens: boundary.keptTokens,
    tailCountRelaxed,
    activeTokens,
    cacheHot,
    reason,
  }
}
