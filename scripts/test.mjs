import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const loader = pathToFileURL(join(root, 'scripts', 'test-loader.mjs')).href
const tests = (await readdir(join(root, 'test')))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join(root, 'test', name))

const child = spawn(process.execPath, [
  '--experimental-loader', loader,
  '--test',
  '--test-reporter=spec',
  ...tests,
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
})

const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', value => resolve(value ?? 1))
})

process.exit(code)
