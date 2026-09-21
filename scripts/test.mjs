import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeModules = join(root, 'node_modules')
const dshScope = join(nodeModules, '@deepseek-ai')

async function stubPackage(name, source) {
  const directory = join(dshScope, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0-test', type: 'module', exports: './index.js' }, null, 2))
  await writeFile(join(directory, 'index.js'), source)
}

await rm(nodeModules, { recursive: true, force: true })
await stubPackage('dsh-tools', `
export function defineTool(definition) { return definition }
`)
await stubPackage('dsh-compaction-basic', `
export class BasicCompactionEngine {
  constructor(ctx, config = {}) {
    this.ctx = ctx; this.config = config
    if (typeof this._registerAutomaticCompaction === 'function') this._registerAutomaticCompaction()
  }
  async summarize(input) {
    if (input?.throwFromBase) throw new Error('base summary failed')
    return { summary: [{ type: 'text', text: input?.baseText ?? 'base checkpoint' }], tokenCount: 7 }
  }
}
export default BasicCompactionEngine
`)
await stubPackage('dsh-llm', `
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export function createUserMessage(data) { return data }
export function errorChain(error) { return [{ message: error instanceof Error ? error.message : String(error) }] }
`)
await stubPackage('schemastery', `
function node() {
  const self = {
    _default: undefined,
    default(value) { self._default = value; return self },
    min() { return self },
    max() { return self },
    step() { return self },
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
}
`)
await stubPackage('dsh-compaction', `
export function toolPairingBalancedBefore() { return true }
export function toolPairingBalancedAfter() { return true }
export function compactCheckpointSource(compactionId) { return { kind: 'plugin', plugin: 'compact', compactionId } }
export function isCompactCheckpointSource(source) { return source?.kind === 'plugin' && source?.plugin === 'compact' }
export const ManualCompactionError = class ManualCompactionError extends Error {}
export const CompactionId = (value) => value
`)

const tests = (await readdir(join(root, 'test')))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join(root, 'test', name))

const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...tests], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
})

const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', value => resolve(value ?? 1))
})

await rm(nodeModules, { recursive: true, force: true })
process.exit(code)