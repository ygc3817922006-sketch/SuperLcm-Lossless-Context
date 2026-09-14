import { contentBlocksToText, extractMarkers, markerFromSummary, stripRecallMetadata } from './marker.js'

function clampInteger(value, fallback, min, max) {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('a live DSH session id is required')
  return id
}

function sessionEvents(session) {
  // rc.2 exposes immutable snapshots; older hosts expose an events array.
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events
  if (!Array.isArray(events)) throw new Error('LCM cannot read session events: unsupported session API')
  return events
}

function eventMapOf(events) {
  const map = new Map()
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) map.set(event.seq, event)
  }
  return map
}

function eventText(event) {
  try {
    return JSON.stringify(event)
  } catch {
    return String(event?.data ?? '')
  }
}

function snippetAround(text, query, width = 360) {
  const normalized = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const at = normalized.indexOf(needle)
  if (at < 0) return text.slice(0, width)
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(text.length, start + width)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function nodeFromCompactionEvent(session, event) {
  if (event?.type !== 'compaction/summary') return null
  const marker = markerFromSummary(event.data?.summary)
  if (marker === null) return null
  const sourceSeqs = Array.isArray(event.data?.shadowedSeqs)
    ? event.data.shadowedSeqs.filter(Number.isSafeInteger)
    : []
  return {
    sessionId: sessionIdOf(session),
    nodeId: marker.id,
    compactionId: String(event.data?.compactionId ?? ''),
    summarySeq: event.seq,
    createdAt: Number.isFinite(event.time) ? event.time : Date.now(),
    summary: event.data?.summary ?? [],
    summaryText: stripRecallMetadata(contentBlocksToText(event.data?.summary ?? [])),
    childIds: marker.children,
    sourceSeqs,
    shadowedTokenCount: Number.isFinite(event.data?.shadowedTokenCount)
      ? event.data.shadowedTokenCount
      : null,
    provider: typeof event.data?.provider === 'string' ? event.data.provider : null,
    model: typeof event.data?.model === 'string' ? event.data.model : null,
    status: 'ready',
  }
}

export function indexCompactionEvent(store, session, event) {
  const node = nodeFromCompactionEvent(session, event)
  if (node === null) return null
  return store.upsertNode(node)
}

export function reindexSession(store, session, { rebuild = false } = {}) {
  const sessionId = sessionIdOf(session)
  const events = sessionEvents(session)
  if (rebuild) store.deleteSession(sessionId)
  let markers = 0
  let indexed = 0
  const errors = []
  for (const event of events) {
    if (event?.type !== 'compaction/summary') continue
    const marker = markerFromSummary(event.data?.summary)
    if (marker === null) continue
    markers += 1
    try {
      indexCompactionEvent(store, session, event)
      indexed += 1
    } catch (error) {
      errors.push({ seq: event.seq, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sessionId, markers, indexed, errors }
}

export function searchSessionEvents(session, query, { limit = 20 } = {}) {
  const needle = String(query ?? '').normalize('NFKC').toLocaleLowerCase().trim()
  if (needle.length === 0) return []
  const capped = clampInteger(limit, 20, 1, 200)
  const hits = []
  for (const event of sessionEvents(session)) {
    const text = eventText(event)
    const normalized = text.normalize('NFKC').toLocaleLowerCase()
    if (!normalized.includes(needle)) continue
    hits.push({
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: event.surfaceOp?.op ?? null,
      snippet: snippetAround(text, needle),
    })
    if (hits.length >= capped) break
  }
  return hits
}

function requireNode(store, sessionId, nodeId) {
  const node = store.getNode(sessionId, nodeId)
  if (node === null) throw new Error(`LCM node not found in this session: ${nodeId}`)
  return node
}

/**
 * Depth of one node in the recall DAG: level 1 for raw fold checkpoints, and
 * one above the deepest child otherwise. Cycle-safe for corrupted indexes.
 */
export function nodeLevel(store, sessionId, nodeId) {
  const seen = new Set()
  const levelOf = (id) => {
    if (seen.has(id)) return 1
    seen.add(id)
    const children = store.childrenOf(sessionId, id)
    if (children.length === 0) return 1
    return 1 + Math.max(...children.map(levelOf))
  }
  return levelOf(nodeId)
}

export function describeNode(store, session, nodeId) {
  const sessionId = sessionIdOf(session)
  const node = requireNode(store, sessionId, nodeId)
  return {
    sessionId,
    nodeId: node.nodeId,
    compactionId: node.compactionId,
    summarySeq: node.summarySeq,
    createdAt: node.createdAt,
    level: nodeLevel(store, sessionId, node.nodeId),
    provider: node.provider,
    model: node.model,
    status: node.status,
    childIds: store.childrenOf(sessionId, node.nodeId),
    parentIds: store.parentsOf(sessionId, node.nodeId),
    sourceSeqCount: node.sourceSeqs.length,
    sourceRange: node.sourceSeqs.length === 0
      ? null
      : { first: node.sourceSeqs[0], last: node.sourceSeqs[node.sourceSeqs.length - 1] },
    shadowedTokenCount: node.shadowedTokenCount,
    summary: node.summaryText,
  }
}

function collectDag(store, sessionId, rootId, depth) {
  const nodes = []
  const seen = new Set()
  const queue = [{ id: rootId, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current.id)) continue
    seen.add(current.id)
    const node = store.getNode(sessionId, current.id)
    if (node === null) {
      nodes.push({ nodeId: current.id, depth: current.depth, missing: true })
      continue
    }
    nodes.push({
      nodeId: node.nodeId,
      depth: current.depth,
      summarySeq: node.summarySeq,
      childIds: node.childIds,
      sourceSeqCount: node.sourceSeqs.length,
      summary: node.summaryText,
    })
    if (current.depth < depth) {
      node.childIds.forEach(child => queue.push({ id: child, depth: current.depth + 1 }))
    }
  }
  return nodes
}

export function expandNode(store, session, {
  nodeId,
  sourceOffset = 0,
  eventCharOffset = 0,
  maxChars = 30000,
  recursiveDepth = 0,
} = {}) {
  const sessionId = sessionIdOf(session)
  const node = requireNode(store, sessionId, nodeId)
  const offset = clampInteger(sourceOffset, 0, 0, Math.max(0, node.sourceSeqs.length))
  const charOffset = clampInteger(eventCharOffset, 0, 0, Number.MAX_SAFE_INTEGER)
  const budget = clampInteger(maxChars, 30000, 1000, 100000)
  const depth = clampInteger(recursiveDepth, 0, 0, 8)
  const events = sessionEvents(session)
  const eventsBySeq = eventMapOf(events)
  const chunks = []
  let used = 0
  let next = null

  for (let index = offset; index < node.sourceSeqs.length; index += 1) {
    const seq = node.sourceSeqs[index]
    const event = eventsBySeq.get(seq)
    const serialized = event === undefined
      ? JSON.stringify({ seq, missing: true })
      : JSON.stringify(event)
    const start = index === offset ? charOffset : 0
    if (start >= serialized.length) continue
    const separatorCost = chunks.length === 0 ? 0 : 1
    const remaining = budget - used - separatorCost
    if (remaining <= 0) {
      next = { sourceOffset: index, eventCharOffset: start }
      break
    }
    const slice = serialized.slice(start, start + remaining)
    chunks.push({
      seq,
      type: event?.type ?? null,
      charOffset: start,
      complete: start + slice.length >= serialized.length,
      content: slice,
    })
    used += separatorCost + slice.length
    if (start + slice.length < serialized.length) {
      next = { sourceOffset: index, eventCharOffset: start + slice.length }
      break
    }
    if (index + 1 < node.sourceSeqs.length && used >= budget) {
      next = { sourceOffset: index + 1, eventCharOffset: 0 }
      break
    }
  }

  return {
    sessionId,
    nodeId: node.nodeId,
    summary: node.summaryText,
    dag: collectDag(store, sessionId, node.nodeId, depth),
    sourceSeqCount: node.sourceSeqs.length,
    chunks,
    next,
  }
}

export function searchLosslessContext(store, session, query, { scope = 'both', limit = 20 } = {}) {
  const sessionId = sessionIdOf(session)
  const capped = clampInteger(limit, 20, 1, 100)
  const normalizedScope = ['summary', 'events', 'both'].includes(scope) ? scope : 'both'
  return {
    sessionId,
    query,
    scope: normalizedScope,
    summaries: normalizedScope === 'events'
      ? []
      : store.searchNodes(sessionId, query, { limit: capped }).map(node => ({
          nodeId: node.nodeId,
          summarySeq: node.summarySeq,
          score: node.score,
          childCount: node.childIds.length,
          sourceSeqCount: node.sourceSeqs.length,
          snippet: snippetAround(node.summaryText, String(query)),
        })),
    events: normalizedScope === 'summary'
      ? []
      : searchSessionEvents(session, query, { limit: capped }),
  }
}

export function doctorSession(store, session) {
  const sessionId = sessionIdOf(session)
  const markers = []
  const markerIds = new Set()
  const duplicates = []
  const invalidSources = []
  const events = sessionEvents(session)
  const eventSeqs = new Set(events.map(event => event?.seq).filter(Number.isSafeInteger))
  for (const event of events) {
    if (event?.type !== 'compaction/summary') continue
    const marker = markerFromSummary(event.data?.summary)
    if (marker === null) continue
    markers.push({ seq: event.seq, id: marker.id })
    if (markerIds.has(marker.id)) duplicates.push(marker.id)
    markerIds.add(marker.id)
    const sourceSeqs = event.data?.shadowedSeqs ?? []
    for (const seq of sourceSeqs) {
      if (!Number.isSafeInteger(seq) || !eventSeqs.has(seq)) {
        invalidSources.push({ summarySeq: event.seq, sourceSeq: seq })
      }
    }
  }
  const stats = store.stats(sessionId)
  const storedIds = new Set(store.listNodes(sessionId, { limit: 5000 }).map(node => node.nodeId))
  const missingInDb = [...markerIds].filter(id => !storedIds.has(id))
  const staleInDb = [...storedIds].filter(id => !markerIds.has(id))
  const quickCheck = store.quickCheck()
  return {
    ok: quickCheck.every(value => value === 'ok')
      && duplicates.length === 0
      && invalidSources.length === 0
      && missingInDb.length === 0
      && staleInDb.length === 0
      && stats.missingChildren.length === 0,
    sessionId,
    databasePath: store.path,
    quickCheck,
    logMarkers: markers.length,
    storedNodes: stats.nodeCount,
    storedEdges: stats.edgeCount,
    duplicates,
    invalidSources,
    missingInDb,
    staleInDb,
    missingChildren: stats.missingChildren,
  }
}

export function markerInventory(value) {
  return extractMarkers(value)
}
