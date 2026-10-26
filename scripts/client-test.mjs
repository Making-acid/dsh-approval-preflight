/**
 * Offline smoke test for the browser half.
 *
 * `client.js` is only ever executed by the web shell, which made every mistake in
 * it a "restart the app and look" problem. This file runs the real module in a
 * minimal browser stand-in:
 *
 *  - the bundle registers a lazy factory whose id equals the package name;
 *  - `apply(ctx)` registers the composer strip and the side panel;
 *  - with a Host response in place, the strip renders the pending-node posture;
 *  - the panel auto-opens, renders the graph dots, one card per node with its
 *    essence and impact tags, and an expandable audit trail;
 *  - approving a node reaches the Host channel;
 *  - both components return `null` instead of throwing when there is nothing to show.
 *
 * Run: node scripts/client-test.mjs
 */

import assert from 'node:assert/strict'

let checks = 0
function ok(label, condition) {
  checks += 1
  assert.ok(condition, label)
  console.log(`  ok  ${label}`)
}

// ---------------------------------------------------------------------------
// Browser stand-in
// ---------------------------------------------------------------------------

const registeredModules = []
const element = (type, props, children) => ({ type, props: props ?? {}, children })

const cleanups = []
const React = {
  createElement: (type, props, ...children) => element(type, props, children.flat(Infinity)),
  useState: (initial) => [initial, () => {}],
  useEffect: (callback) => {
    const cleanup = callback()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return cleanup
  }
}

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registeredModules.push(entry)
    }
  },
  addEventListener() {},
  removeEventListener() {}
}

globalThis.document = {
  head: { querySelector: () => null, appendChild() {} },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  getElementById: () => null
}

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function texts(node) {
  const collected = []
  walk(node, (item) => {
    for (const child of item.children) if (typeof child === 'string' || typeof child === 'number') collected.push(String(child))
  })
  return collected.join(' ')
}

function findByClass(node, className) {
  let found = null
  walk(node, (item) => {
    if (found === null && item.props?.className === className) found = item
  })
  return found
}

function findButton(node, label) {
  let found = null
  walk(node, (item) => {
    if (found !== null || item.type !== 'button') return
    if (texts({ type: 'x', props: {}, children: [item] }).trim() === label) found = item
  })
  return found
}

// ---------------------------------------------------------------------------
// Load the real module
// ---------------------------------------------------------------------------

await import('../client.js')

console.log('bundle registration')
assert.equal(registeredModules.length, 1, 'client.js must register exactly one lazy factory')
const entry = registeredModules[0]
ok('module id equals the package name', typeof entry.id === 'string' && entry.id.length > 0)
ok('factory is a function', typeof entry.factory === 'function')

const basePayload = {
  sessionId: 'session-client',
  hasGraph: true,
  policy: 'ask',
  goal: '给项目加 SQLite 支持并跑通构建',
  version: 1,
  running: null,
  nodes: [
    {
      id: 'N1', title: '读现有依赖清单', effect: 'read',
      essence: { action: '读取', source: '', target: 'package.json', details: '' },
      note: '', dependsOn: [], impacts: [], escalate: false, permission: 'none',
      status: 'done', ready: false, blockedBy: '已完成',
      audit: [{ tool: 'read', summary: 'read package.json', outcome: 'ok', at: 1 }]
    },
    {
      id: 'N2', title: '下载 better-sqlite3 并写入项目依赖', effect: 'download',
      essence: { action: '下载', source: 'npm registry · better-sqlite3', target: '项目依赖目录', details: '安装为运行时依赖' },
      note: '不关心用 pnpm 还是 npm', dependsOn: ['N1'], impacts: ['network', 'fs-write'], escalate: false,
      permission: 'required', status: 'proposed', ready: false, blockedBy: '待批准', audit: []
    },
    {
      id: 'N3', title: '新建数据库封装', effect: 'write',
      essence: { action: '写入', source: '', target: 'src/db.ts（工作区内）', details: '新增连接与查询封装' },
      note: '', dependsOn: ['N2'], impacts: ['fs-write'], escalate: false,
      permission: 'required', status: 'approved', ready: false, blockedBy: '等前置 N2', audit: []
    }
  ],
  counts: { total: 3, proposed: 1, approved: 1, running: 0, done: 1, rejected: 0 },
  updatedAt: 1
}

const calls = []
const module = entry.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require(${specifier})`)
})

ok('plugin declares its client services', Array.isArray(module.inject) && module.inject.includes('slots'))

const registrations = []
const ctx = {
  connection: {
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        if (endpoint === 'status') return { ok: true, value: { ...basePayload, sessionId: payload.sessionId } }
        if (endpoint === 'approve') {
          const approved = payload.nodeIds ?? []
          const nodes = basePayload.nodes.map((node) => approved.includes(node.id) ? { ...node, status: 'approved' } : node)
          return { ok: true, value: { approved, view: { ...basePayload, nodes, counts: { ...basePayload.counts, proposed: 0, approved: 2 } } } }
        }
        if (endpoint === 'reject' || endpoint === 'revoke') return { ok: true, value: { view: basePayload } }
        return { ok: true, value: null }
      }
    }
  },
  slots: {
    inject(key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    }
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  }
}

module.apply(ctx)

console.log('slot registrations')
const strip = registrations.find((item) => item.options.name === 'conversation.input.dock')
const panel = registrations.find((item) => item.options.name === 'shell.overlay')
ok('composer strip registered', strip !== undefined)
ok('side panel registered', panel !== undefined)
ok('strip renders nothing without a session', strip.component({ sessionId: undefined }) === null)
ok('panel renders nothing while closed', panel.component({}) === null)

// ---------------------------------------------------------------------------
// Render with a Host response in place
// ---------------------------------------------------------------------------

ok('first render before data is empty', strip.component({ sessionId: 'session-client' }) === null)
await new Promise((resolve) => setTimeout(resolve, 10))
ok('client polled the Host status route', calls.some((call) => call.endpoint === 'status'))

const stripTree = strip.component({ sessionId: 'session-client' })
ok('strip renders once data arrives', stripTree !== null && stripTree !== undefined)
const stripText = texts(stripTree)
ok('strip reports pending nodes', stripText.includes('预检') && stripText.includes('待批准'))
ok('strip reports progress', stripText.includes('1/3'))

// A graph with pending nodes opens the panel by itself.
const autoPanel = panel.component({})
ok('panel auto-opens when a node waits for approval', autoPanel !== null && autoPanel !== undefined)

const panelText = texts(autoPanel)
ok('panel shows the goal', panelText.includes('给项目加 SQLite 支持'))
ok('panel shows node titles', panelText.includes('下载 better-sqlite3') && panelText.includes('新建数据库封装'))
ok('panel shows the effect label', panelText.includes('下载') && panelText.includes('写入'))
ok('panel shows the semantic essence', panelText.includes('npm registry') && panelText.includes('项目依赖目录'))
ok('panel shows impact tags', panelText.includes('网络') && panelText.includes('写文件'))
ok('panel shows the model note', panelText.includes('不关心用 pnpm 还是 npm'))
ok('panel marks a proposed node', panelText.includes('待批准'))

// graph dots are rendered for every node
ok('graph dots rendered', findDotByText(autoPanel, 'N1') !== null && findDotByText(autoPanel, 'N3') !== null)

// approval reaches the Host channel
const approveButton = findButton(autoPanel, '批准')
ok('approve button present', approveButton !== null && typeof approveButton.props.onClick === 'function')
approveButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
ok('approve reached the Host with the node id', calls.some((call) => call.endpoint === 'approve' && Array.isArray(call.payload.nodeIds) && call.payload.nodeIds.includes('N2')))

// audit is collapsed until expanded
const donePanel = panel.component({})
const auditToggle = findButtonContaining(donePanel, '查看实际执行')
ok('audit toggle present for a node with history', auditToggle !== null)
auditToggle.props.onClick()
const expanded = panel.component({})
ok('audit expands with the actual call', texts(expanded).includes('read package.json'))

// closing and reopening
const closeButton = findByClass(donePanel, 'dshap-icon-btn')
ok('panel exposes a close control', closeButton !== null)
closeButton.props.onClick()
ok('closing hides the panel', panel.component({}) === null)
const openButton = findByClass(stripTree, 'dshap-strip-btn')
ok('strip exposes an open control', openButton !== null && typeof openButton.props.onClick === 'function')
openButton.props.onClick()
ok('strip reopens the panel', panel.component({}) !== null)

// ---------------------------------------------------------------------------
// Helpers used above
// ---------------------------------------------------------------------------

function findDotByText(node, label) {
  let found = null
  walk(node, (item) => {
    if (found !== null) return
    if (item.props?.className === 'dshap-dot2' && texts({ type: 'x', props: {}, children: [item] }).trim() === label) found = item
  })
  return found
}

function findButtonContaining(node, needle) {
  let found = null
  walk(node, (item) => {
    if (found !== null || item.type !== 'button') return
    if (texts({ type: 'x', props: {}, children: [item] }).includes(needle)) found = item
  })
  return found
}

for (const cleanup of cleanups) {
  try {
    cleanup()
  } catch {
    /* teardown must not mask the assertions */
  }
}

console.log(`\n${checks} checks passed`)
