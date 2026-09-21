import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function text(path) {
  return readFile(join(root, path), 'utf8')
}

test('package exports the backend and all stable library leaves', async () => {
  const pkg = JSON.parse(await text('package.json'))
  assert.equal(pkg.name, 'SuperLcm')
  assert.equal(pkg.version, '0.3.0-alpha.6')
  assert.deepEqual(pkg.exports, {
    '.': './src/engine.js',
    './tool': './src/tool.js',
    './core': './src/core.js',
    './marker': './src/marker.js',
    './store': './src/store.js',
    './client': './lib/client.js',
  })
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-plugins'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'))
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-compaction'], '*')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm'], '*')
})

test('web settings expose an atomic catalog-backed summarizer route and rolling defaults', async () => {
  const client = await text('lib/client.js')
  assert.match(client, /summarizationRoute/)
  assert.match(client, /remote\.session\.modelCatalog\(\)/)
  assert.match(client, /const inject = \[[^\]]*"remote\.session"[^\]]*\]/)
  assert.match(client, /scope\.set\("summarizationRoute", desired\)/)
  assert.doesNotMatch(client, /scope\.set\("summarizationProvider"/)
  assert.doesNotMatch(client, /scope\.set\("summarizationModel"/)
  assert.match(client, /foldBatchTokens:\s*64000/)
  assert.match(client, /softActiveTokens:\s*160000/)
  assert.match(client, /hardActiveTokens:\s*220000/)
  assert.doesNotMatch(client, /cacheTtlSeconds/)
  assert.match(client, /plugins\.bundle\.config/)
  assert.match(client, /key:\s*"SuperLcm"/)
  assert.match(client, /SETTINGS_NAMESPACE = "superlcm"/)
  assert.doesNotMatch(client, /settings\.plugin\.item/)
  assert.doesNotMatch(client, /SETTINGS_NAMESPACE = "SuperLcm"/)
})

test('default bundle is safe: tools are mounted but no second compaction provider is auto-mounted', async () => {
  const patch = await text('cordis.patch.yml')
  assert.match(patch, /SuperLcm\/tool/)
  assert.doesNotMatch(patch, /^\s*name:\s*SuperLcm\s*$/m)
  assert.doesNotMatch(patch, /dsh-compaction-basic/)
})

test('publication list contains documentation and excludes tests and transient databases', async () => {
  const pkg = JSON.parse(await text('package.json'))
  assert.ok(pkg.files.includes('src/'))
  assert.ok(pkg.files.includes('docs/'))
  assert.ok(pkg.files.includes('examples/'))
  assert.ok(!pkg.files.includes('test/'))
  assert.ok(!pkg.files.some(value => value.endsWith('.sqlite')))
})
