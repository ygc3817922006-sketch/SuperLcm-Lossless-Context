#!/usr/bin/env node
/**
 * 升级前试飞闸 / pre-upgrade preflight gate.
 *
 * 回答的问题:把 dsh 升到 <version> 之后,SuperLcm 会不会崩?
 *
 * 方法论只有一条:**差分**。同一套检查同时跑在
 *   - 基线 = 本机现役 dsh(已知能用)
 *   - 候选 = 目标版本(装进隔离目录,绝不触碰现役)
 * 只报"候选相对基线新增的问题"。绝对判定会产出假警报 ——
 * 本仓库的测试原本是配桩写的,直接对真包跑必然大量失败,
 * 那些失败与版本无关;不做基线对照就会误判成 breaking change。
 *
 * 三层检查:
 *   L1 契约面  导出符号、基类 Config 字段集、客户端服务名/插槽名
 *   L2 差分测试 用目标版本的真实包跑本仓库测试,对比失败用例集合
 *   L3 组合挂载 用候选 CLI 组合真实 profile,确认 SuperLcm 条目仍在、退出码 0
 *
 * 用法:
 *   node scripts/preflight-upgrade.mjs 0.1.7-rc.2 [--profile acp] [--json]
 *   node scripts/preflight-upgrade.mjs --latest        # 取 npm 上的 next 标签
 *
 * 退出码:0 = 未发现新增不兼容;1 = 发现;2 = 环境/前置失败
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(tmpdir(), 'slcm-preflight')

/** SuperLcm 依赖的 dsh 导出符号。新增依赖时同步补这里。 */
const CONTRACT_SYMBOLS = [
  ['dsh-compaction', ['CompactionId', 'compactCheckpointSource', 'isCompactCheckpointSource', 'toolPairingBalancedAfter', 'toolPairingBalancedBefore']],
  ['dsh-llm', ['CONTEXT_WINDOW_EXCEEDED_CODE', 'createUserMessage', 'errorChain']],
  ['dsh-tools', ['defineTool']],
  ['dsh-compaction-basic', ['BasicCompactionEngine']],
]

/** 客户端注入的服务名,以及 SuperLcm 注册的插槽名。 */
const CLIENT_SERVICES = ['configForms', 'slots', 'locale', 'remote']
const CLIENT_SLOTS = ['plugins.bundle.config']

/** 测试需要的运行时包(测试对真包跑时要能解析到)。 */
const TEST_PACKAGES = ['schemastery', 'dsh-compaction', 'dsh-compaction-basic', 'dsh-llm', 'dsh-tools']

const run = (cmd, args, options = {}) => {
  try {
    return { out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }), code: 0 }
  } catch (error) {
    return { out: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status ?? 1 }
  }
}

/** 现役 dsh 的 @deepseek-ai 包目录。 */
function baselineModules() {
  const which = run('which', ['dsh']).out.trim()
  if (!which) throw new Error('找不到现役 dsh(which dsh 为空)')
  let dir = dirname(run('realpath', [which]).out.trim())
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai')
    if (existsSync(join(candidate, 'dsh')) || existsSync(join(candidate, 'schemastery'))) return candidate
    const nested = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
    if (existsSync(nested)) return nested
    dir = dirname(dir)
  }
  throw new Error(`从 ${which} 找不到现役 @deepseek-ai 包目录`)
}

function packageVersion(modules, name) {
  try {
    return JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

function packageEntry(modules, name) {
  const pkg = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'))
  const root = pkg.exports?.['.']
  return join(modules, name, (root && (root.import ?? root.default)) ?? pkg.main)
}

/** L1:导出符号 + 基类 Config 字段集 + 客户端服务名与插槽。 */
async function contractFindings(modules) {
  const findings = { missingSymbols: [], baseConfigKeys: [], missingServices: [], slots: {} }

  for (const [pkg, symbols] of CONTRACT_SYMBOLS) {
    let mod
    try {
      mod = await import(packageEntry(modules, pkg))
    } catch (error) {
      findings.missingSymbols.push(`${pkg}: 无法导入 (${error.message})`)
      continue
    }
    for (const symbol of symbols) if (mod[symbol] === undefined) findings.missingSymbols.push(`${pkg}.${symbol}`)
  }

  try {
    const { BasicCompactionEngine } = await import(packageEntry(modules, 'dsh-compaction-basic'))
    findings.baseConfigKeys = Object.keys(BasicCompactionEngine?.Config?.dict ?? {}).sort()
  } catch (error) {
    findings.missingSymbols.push(`dsh-compaction-basic.Config 不可读 (${error.message})`)
  }

  const clientBundles = run('bash', ['-lc', `ls -d ${modules}/dsh-client-*/lib/client.js 2>/dev/null`]).out
    .split('\n').filter(Boolean)
  for (const service of CLIENT_SERVICES) {
    const hits = clientBundles.filter((file) => readFileSync(file, 'utf8').includes(service))
    if (hits.length === 0) findings.missingServices.push(service)
  }
  for (const slot of CLIENT_SLOTS) {
    findings.slots[slot] = clientBundles.filter((file) => readFileSync(file, 'utf8').includes(slot)).length
  }
  return findings
}

/** SuperLcm 自己声明的 Config 字段(用于确认基类字段没有被漏掉)。 */
function declaredConfigKeys() {
  const source = readFileSync(join(REPO, 'src/engine.js'), 'utf8')
  const block = source.slice(source.indexOf('static Config = z.object({'))
  const body = block.slice(block.indexOf('{') + 1, block.indexOf('\n  })'))
  return [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort()
}

/** L2:把仓库复制到隔离目录、指向该版本的真包,跑测试并收集失败用例名。 */
function differentialTests(modules, label) {
  const target = join(WORK, `src-${label}`)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of ['src', 'lib', 'test', 'scripts', 'package.json']) {
    cpSync(join(REPO, entry), join(target, entry), { recursive: true })
  }
  mkdirSync(join(target, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const pkg of TEST_PACKAGES) {
    const from = join(modules, pkg)
    if (existsSync(from)) symlinkSync(from, join(target, 'node_modules', '@deepseek-ai', pkg))
  }
  const result = run('node', ['--test', 'test/client-contract.test.js', 'test/engine.test.js',
    'test/settings.test.js', 'test/tool.test.js', 'test/store.test.js', 'test/marker.test.js',
    'test/rolling.test.js', 'test/async-region.test.js', 'test/recall.test.js', 'test/package.test.js'],
  { cwd: target })
  const failures = result.out.split('\n').filter((line) => line.startsWith('not ok'))
    .map((line) => line.replace(/^not ok \d+ - /, '').trim()).sort()
  return { failures, raw: result.out }
}

/** L3:用候选 CLI 组合一个真实 profile,确认条目仍在且退出码为 0。 */
function composition(modules, profile) {
  const cli = join(modules, 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) return { skipped: '候选 CLI 不存在' }
  const result = run('node', [cli, '--profile', profile, '--dump-config'], { env: { ...process.env } })
  const warnings = result.out.split('\n').filter((line) => /not found|pending|waiting for service/.test(line))
  return {
    exit: result.code,
    superLcmRows: (result.out.match(/SuperLcm/g) ?? []).length,
    warnings,
  }
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'acp'
let version = args.find((arg) => !arg.startsWith('--') && arg !== profile)
if (args.includes('--latest') || version === undefined) {
  const tags = run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json']).out
  version = JSON.parse(tags).next ?? JSON.parse(tags).alpha
}

const baseline = baselineModules()
const candidate = join(WORK, version, 'node_modules', '@deepseek-ai')
if (!existsSync(join(candidate, 'schemastery'))) {
  mkdirSync(join(WORK, version), { recursive: true })
  writeFileSync(join(WORK, version, 'package.json'), JSON.stringify({ name: 'slcm-preflight', private: true, version: '0.0.0' }))
  const install = run('npm', ['install', `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund'], { cwd: join(WORK, version) })
  if (install.code !== 0) {
    console.error(`无法安装候选版本 ${version}:\n${install.out.slice(-2000)}`)
    process.exit(2)
  }
}

const report = {
  version,
  profile,
  baseline: { dsh: run('dsh', ['--version']).out.trim().split('\n').pop(), schemastery: packageVersion(baseline, 'schemastery') },
  candidate: { dsh: packageVersion(candidate, 'dsh'), schemastery: packageVersion(candidate, 'schemastery') },
  regressions: [],
  warnings: [],
}

const [baseFindings, candFindings] = [await contractFindings(baseline), await contractFindings(candidate)]
const declared = declaredConfigKeys()

for (const symbol of candFindings.missingSymbols) {
  if (!baseFindings.missingSymbols.includes(symbol)) report.regressions.push(`契约符号消失: ${symbol}`)
}
for (const service of candFindings.missingServices) {
  if (!baseFindings.missingServices.includes(service)) report.regressions.push(`客户端服务消失: ${service}`)
}
for (const [slot, count] of Object.entries(candFindings.slots)) {
  if (count === 0 && baseFindings.slots[slot] > 0) report.regressions.push(`插槽不再被官方派发: ${slot}`)
}
const undeclared = candFindings.baseConfigKeys.filter((key) => !declared.includes(key))
for (const key of undeclared) {
  if (!baseFindings.baseConfigKeys.includes(key)) {
    report.regressions.push(`基类新增字段 ${key} 未在 SuperLcm Config 中声明(splitConfig 会丢弃)`)
  }
}
const vanished = baseFindings.baseConfigKeys.filter((key) => !candFindings.baseConfigKeys.includes(key) && declared.includes(key))
for (const key of vanished) report.warnings.push(`基类字段 ${key} 在候选版本中消失`)

const baseTests = differentialTests(baseline, 'baseline')
const candTests = differentialTests(candidate, version)
const newFailures = candTests.failures.filter((name) => !baseTests.failures.includes(name))
const fixedFailures = baseTests.failures.filter((name) => !candTests.failures.includes(name))
for (const name of newFailures) report.regressions.push(`测试新增失败: ${name}`)

report.tests = {
  baselineFailures: baseTests.failures.length,
  candidateFailures: candTests.failures.length,
  newFailures: newFailures.length,
  fixedFailures: fixedFailures.length,
}
report.composition = composition(candidate, profile)
if (report.composition.exit !== 0) report.regressions.push(`组合 ${profile} profile 退出码 ${report.composition.exit}`)
if (report.composition.superLcmRows === 0) report.regressions.push(`组合结果里找不到 SuperLcm 条目`)
for (const warning of report.composition.warnings ?? []) report.warnings.push(`组合告警: ${warning}`)

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`上游版本: 现役 ${report.baseline.dsh} / 候选 ${report.candidate.dsh}`)
  console.log(`底层依赖: schemastery ${report.baseline.schemastery} -> ${report.candidate.schemastery}`)
  console.log(`基类 Config 字段: ${baseFindings.baseConfigKeys.length} -> ${candFindings.baseConfigKeys.length}`)
  console.log(`测试失败(环境因素,两边都有属正常): ${report.tests.baselineFailures} -> ${report.tests.candidateFailures}`)
  console.log(`组合 ${profile}: exit=${report.composition.exit} SuperLcm 条目=${report.composition.superLcmRows}`)
  console.log(report.regressions.length === 0 ? '\n✅ 未发现新增不兼容,可以升级' : '\n❌ 发现新增不兼容:')
  for (const item of report.regressions) console.log('   ' + item)
  for (const item of report.warnings) console.log('   (提示) ' + item)
}
process.exit(report.regressions.length === 0 ? 0 : 1)
