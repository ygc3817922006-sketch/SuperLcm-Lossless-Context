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
  assert.equal(pkg.version, '0.3.0-alpha.10')
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
  assert.match(client, /fallbackSummarizationRoute/)
  assert.match(client, /fallbackSummarizerHeading/)
  assert.match(client, /remote\.session\.modelCatalog\(\)/)
  assert.match(client, /const inject = \[[^\]]*"remote\.session"[^\]]*\]/)
  assert.match(client, /scope\.set\(field, desired\)/)
  assert.doesNotMatch(client, /scope\.set\("summarizationProvider"/)
  assert.doesNotMatch(client, /scope\.set\("summarizationModel"/)
  assert.match(client, /foldBatchTokens:\s*64000/)
  assert.match(client, /softActiveTokens:\s*160000/)
  assert.match(client, /hardActiveTokens:\s*220000/)
  assert.doesNotMatch(client, /cacheTtlSeconds/)
  assert.doesNotMatch(client, /thresholdRatio/)
  assert.doesNotMatch(client, /retainRatio/)
  assert.match(client, /scope\.mutate\(ops, before\.revision\)/)
  assert.doesNotMatch(client, /await scope\.set\(field\.key/)
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
  assert.ok(pkg.files.includes('docs/*.md'))
  assert.ok(!pkg.files.includes('docs/'))
  assert.ok(pkg.files.includes('assets/'))
  assert.ok(pkg.files.includes('examples/'))
  assert.ok(pkg.files.includes('README.en.md'))
  assert.ok(!pkg.files.includes('test/'))
  assert.ok(!pkg.files.some(value => value.endsWith('.sqlite')))
})

test('repository README is the Chinese-first detailed project page', async () => {
  const [readme, english, store, animation] = await Promise.all([
    text('README.md'),
    text('README.en.md'),
    text('src/store.js'),
    readFile(join(root, 'assets/lcm-principle.gif')),
  ])
  assert.match(readme, /^# SuperLcm — Lossless Context$/m)
  assert.match(english, /^# SuperLcm — Lossless Context$/m)
  assert.match(readme, /losslesscontext\.ai/)
  assert.match(readme, /assets\/lcm-principle\.gif/)
  assert.match(readme, /全面异步压缩/)
  assert.match(readme, /SQLite 里到底放了什么/)
  assert.match(readme, /lcm_expand/)
  assert.doesNotMatch(readme, /github\.io/)
  assert.equal(animation.subarray(0, 6).toString('ascii'), 'GIF89a')
  assert.doesNotMatch(store, /\/Users\//)
  assert.doesNotMatch(store, /process\.platform\s*===\s*['"]darwin/)
})
