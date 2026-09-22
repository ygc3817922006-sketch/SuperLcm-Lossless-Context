import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SuperLcmCompactionEngine from '../src/engine.js'

// dsh 0.1.7 回归防护：客户端必须走 configForms 的镜像 API
// （describe().getSnapshot().view.namespaces + ensure + subscribe）。
// 2026-09-22 的事故是把 describe() 的返回值当数组遍历，导致整个设置页抛错、
// 参数完全不显示。这里用一个最小 React 运行时把客户端真正渲染一遍。

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 最小 React：支持客户端用到的 5 个 API，并能跑 effect 后的重渲染。 */
function createMiniReact() {
  let states = []
  let cursor = 0
  let effectQueue = []
  let dirty = false

  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
    },
    useState(initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = initial
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next
        dirty = true
      }]
    },
    useEffect(fn) {
      effectQueue.push(fn)
    },
    useCallback(fn) {
      return fn
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot()
    },
    beginPass() {
      cursor = 0
      effectQueue = []
      dirty = false
    },
    reset() {
      states = []
      cursor = 0
      effectQueue = []
      dirty = false
    },
    get effects() {
      return effectQueue
    },
    get dirty() {
      return dirty
    },
    clearDirty() {
      dirty = false
    },
  }
}

/**
 * describe 视图里的 schema 是 schemastery 的序列化信封（`{uid, refs}`）。
 * 真依赖在场时直接取真实信封；测试 loader 用的是 schemastery 桩（没有 toJSON），
 * 退回同形构造，保证「按字段名发现条目」这条契约仍被覆盖。
 */
function realSchemaEnvelope() {
  const config = SuperLcmCompactionEngine.Config
  if (typeof config?.toJSON === 'function') return config.toJSON()
  return { uid: 7, refs: { 7: { type: 'object', dict: {
    summarizationProvider: { type: 'string' },
    fallbackSummarizationModel: { type: 'string' },
    foldBatchTokens: { type: 'number' },
  } } } }
}

async function loadClient(miniReact) {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  let captured
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, module: factory((name) => {
          if (name === 'react') return miniReact
          throw new Error(`unexpected require(${name})`)
        }) }
      },
    },
  }
  // 客户端是给浏览器模块加载器用的，用 Function 提供 window 后求值。
  const run = new Function('window', `${source}\nreturn window.__ModuleLoader__;`)
  run(window)
  assert.ok(captured, 'client bundle did not register a module')
  return captured.module
}

/** 递归展开函数组件，只保留宿主元素与文本。 */
function renderTree(miniReact, node) {
  if (node === undefined || node === null || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => renderTree(miniReact, child))
  if (typeof node.type === 'function') return renderTree(miniReact, node.type(node.props ?? {}))
  return { ...node, props: { ...node.props, children: renderTree(miniReact, node.props?.children) } }
}

/** 渲染一个组件，跑完 effect 与其引发的重渲染（最多 20 轮）。 */
function renderFully(miniReact, Component, props) {
  miniReact.reset()
  let tree
  for (let pass = 0; pass < 20; pass += 1) {
    miniReact.beginPass()
    tree = renderTree(miniReact, Component(props))
    for (const effect of miniReact.effects) effect()
    const settled = !miniReact.dirty
    if (settled) break
    miniReact.clearDirty()
  }
  return tree
}

function collectText(node, out) {
  if (node === undefined || node === null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  collectText(node.props?.children, out)
  return out
}

/** 组装一个近似宿主的 ctx，configForms.describe() 返回真实的镜像语义。 */
function buildContext({ namespaces, miniReact, onEnsure }) {
  const mirrorFace = {
    getSnapshot: () => ({ status: 'ready', view: { namespaces, writable: true, hasDocument: true }, error: null }),
    subscribe: () => () => {},
    ensure: async () => {
      onEnsure?.()
    },
    acceptView: () => {},
  }

  const form = {
    getSnapshot: () => ({
      status: 'ready',
      value: {
        summarizationProvider: 'openai',
        summarizationModel: 'gpt-5.6-sol',
        fallbackSummarizationProvider: '',
        fallbackSummarizationModel: '',
        tailCount: 24,
        minRetainTokens: 32000,
        pressureFoldTokens: 20000,
        foldBatchTokens: 64000,
        softActiveTokens: 160000,
        hardActiveTokens: 220000,
        foldTiming: 'background',
      },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }

  const registered = []
  const ctx = {
    effect: (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, Component) => {
        registered.push({ options, Component })
        return () => {}
      },
    },
    remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [], default: null } }) } },
    configForms: {
      describe: () => mirrorFace,
      get: (entryId) => (entryId === undefined ? undefined : form),
    },
  }
  return { ctx, registered, mirrorFace, form, miniReact }
}

test('client resolves the engine entry through the configForms describe mirror', async () => {
  const miniReact = createMiniReact()
  const module = await loadClient(miniReact)
  let ensured = false
  const { ctx, registered } = buildContext({
    miniReact,
    onEnsure: () => {
      ensured = true
    },
    namespaces: [
      { ns: 'llm-deepseek', schema: { uid: 1, refs: {} }, value: {}, applies: 'live', secrets: [], revision: 1, autoGenerate: true },
      // 引擎条目的 id 由部署方自定：这里故意用本地实际的 SuperLcm-compaction，
      // 而不是示例里的 SuperLcm-engine，验证是按 schema 特征发现而非硬编码。
      { ns: 'SuperLcm-compaction', schema: realSchemaEnvelope(), value: {}, applies: 'live', secrets: [], revision: 1, autoGenerate: true },
    ],
  })

  module.apply(ctx)
  assert.equal(registered.length, 1, 'expected one bundle.config registration')
  const entry = registered[0]
  assert.equal(entry.options.name, 'plugins.bundle.config')
  assert.equal(entry.options.key, 'SuperLcm')

  assert.ok(ensured, 'apply should kick off the first describe read with ensure()')

  const injected = entry.options.inject()
  const tree = renderFully(miniReact, entry.Component, { ...injected, view: 'page' })
  assert.ok(tree, 'component must render')

  const text = collectText(tree, []).join(' ')
  assert.doesNotMatch(text, /unavailable/, 'resolved engine entry must not render the unavailable note')
  assert.match(text, /summarizerHeading/, 'expected the summarizer picker to render')
})

test('client reports loading (not unavailable) while the mirror has no answer yet', async () => {
  const miniReact = createMiniReact()
  const module = await loadClient(miniReact)
  const { ctx, registered } = buildContext({ miniReact, namespaces: [] })

  module.apply(ctx)
  const injected = registered[0].options.inject()
  const tree = renderFully(miniReact, registered[0].Component, { ...injected, view: 'page' })
  const text = collectText(tree, []).join(' ')
  // 镜像还没答案时应显示「加载中」，而不是误报「设置服务不可用」。
  assert.match(text, /loading/)
  assert.doesNotMatch(text, /unavailable/)
})

test('client renders the one-line summary without touching the form', async () => {
  const miniReact = createMiniReact()
  const module = await loadClient(miniReact)
  const { ctx, registered } = buildContext({ miniReact, namespaces: [] })

  module.apply(ctx)
  const injected = registered[0].options.inject()
  const tree = renderFully(miniReact, registered[0].Component, { ...injected, view: 'summary' })
  const text = collectText(tree, []).join(' ')
  assert.equal(text.trim(), 'intro')
})
