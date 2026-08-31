import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendRecallEnvelope,
  contentBlocksToText,
  decodeMarkerPayload,
  encodeMarker,
  extractChildNodeIds,
  extractMarkers,
  extractMarkersFromText,
  markerFromSummary,
  stripRecallMetadata,
} from '../src/marker.js'

test('marker round-trip preserves id and unique child ids', () => {
  const encoded = encodeMarker({
    id: 'node-12345678',
    children: ['child-12345678', 'child-12345678', 'child-87654321'],
  })
  const [marker] = extractMarkersFromText(`before ${encoded} after`)
  assert.deepEqual(marker, {
    id: 'node-12345678',
    children: ['child-12345678', 'child-87654321'],
  })
})

test('corrupt or wrong-version marker payload is ignored', () => {
  assert.equal(decodeMarkerPayload('not-base64-json'), null)
  const wrong = Buffer.from(JSON.stringify({ v: 999, id: 'node-12345678' })).toString('base64url')
  assert.equal(decodeMarkerPayload(wrong), null)
})

test('nested content traversal finds markers once and avoids cycles', () => {
  const marker = encodeMarker({ id: 'node-12345678' })
  const value = { a: [{ text: marker }, marker] }
  value.self = value
  assert.deepEqual(extractMarkers(value), [{ id: 'node-12345678', children: [] }])
  assert.deepEqual(extractChildNodeIds(value), ['node-12345678'])
})

test('content block text extraction excludes schema labels such as type=text', () => {
  assert.equal(contentBlocksToText([{ type: 'text', text: 'checkpoint body' }]), 'checkpoint body')
})

test('recall envelope is machine-readable and removable from human summary text', () => {
  const summary = appendRecallEnvelope([{ type: 'text', text: 'checkpoint body' }], {
    id: 'node-12345678',
    children: ['child-12345678'],
  })
  assert.deepEqual(markerFromSummary(summary), {
    id: 'node-12345678',
    children: ['child-12345678'],
  })
  const joined = summary.map(block => block.text).join('\n')
  assert.equal(stripRecallMetadata(joined), 'checkpoint body')
})
