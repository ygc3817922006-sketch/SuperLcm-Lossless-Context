import { readdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const roots = ['src', 'lib', 'test', 'scripts', 'claude']
const files = []

async function walk(relative) {
  const absolute = join(root, relative)
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) await walk(child)
    else if (extname(entry.name) === '.js' || extname(entry.name) === '.mjs') files.push(child)
  }
}

for (const directory of roots) await walk(directory)
files.sort()

for (const relative of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, relative)], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
}

console.log(`syntax check: ${files.length} files`)