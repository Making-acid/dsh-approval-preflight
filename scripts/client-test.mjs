/**
 * Offline smoke test for the browser half.
 *
 * `client.js` is only ever executed by the web shell, which made every mistake in
 * it a "restart the app and look" problem. This file runs the real module in a
 * minimal browser stand-in:
 *
 *  - the bundle registers a lazy factory whose id equals the package name;
 *  - `apply(ctx)` registers the composer strip and the side panel through
 *    `ctx.slots.inject` / `ctx.slots.register`;
 *  - with a Host response in place, the strip renders Chinese status text;
 *  - opening the panel and rendering it does not throw and shows the permission
 *    table;
 *  - both components return `null` instead of throwing when there is no session.
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

/** Enough of React for hook-using function components outside a renderer. */
const cleanups = []
const React = {
  createElement: (type, props, ...children) => element(type, props, children.flat(Infinity)),
  useState: (initial) => [initial, () => {}],
  useEffect: (callback) => {
    const cleanup = callback()
    // Collect instead of discarding: the polling interval and the key listener are
    // real resources, and an un-cleaned interval keeps Node from exiting.
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
  createElement: () => ({ dataset: {}, textContent: '', remove() {} })
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

// ---------------------------------------------------------------------------
// Load the real module
// ---------------------------------------------------------------------------

await import('../client.js')

console.log('bundle registration')
assert.equal(registeredModules.length, 1, 'client.js must register exactly one lazy factory')
const entry = registeredModules[0]
ok('module id equals the package name', typeof entry.id === 'string' && entry.id.length > 0)
ok('factory is a function', typeof entry.factory === 'function')

const panelPayload = {
  sessionId: 'session-client',
  hasAgent: true,
  policy: 'ask',
  goal: '离线渲染验证',
  note: 'contract test',
  planAt: 1,
  tasks: [
    { id: 'T1', title: '读取结构', state: 'pending', needs: [], dependsOn: [], note: '', ready: true, missingDeps: [], missingGrants: [] },
    { id: 'T2', title: '跑测试', state: 'pending', needs: ['exec'], dependsOn: ['T1'], note: '', ready: false, missingDeps: ['T1'], missingGrants: ['exec'] }
  ],
  classes: [
    {
      id: 'exec',
      label: { zh: '执行命令', en: 'Run commands', hintZh: 'pwsh / bash', hintEn: 'pwsh / bash' },
      required: true,
      granted: false,
      grantedAt: 0,
      pending: false,
      pendingAt: 0,
      pendingTool: ''
    }
  ],
  counts: { tasks: 2, done: 0, ready: 1, missing: 1, pending: 0 },
  updatedAt: 1
}

const calls = []
const fakeReact = React
const module = entry.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected require(${specifier})`)
})

ok('plugin declares its client services', Array.isArray(module.inject) && module.inject.includes('slots'))

const registrations = []
const effects = []
const ctx = {
  connection: {
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        if (endpoint === 'status') return { ok: true, value: { ...panelPayload, sessionId: payload.sessionId } }
        if (endpoint === 'grant') return { ok: true, value: { accepted: payload.classes, view: panelPayload } }
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
    if (typeof disposer === 'function') effects.push(disposer)
    return disposer ?? (() => {})
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

// The first render starts the poll; the store fills after the promise settles.
ok('first render before data is empty', strip.component({ sessionId: 'session-client' }) === null)
await new Promise((resolve) => setTimeout(resolve, 10))
ok('client polled the Host status route', calls.some((call) => call.endpoint === 'status'))

const stripTree = strip.component({ sessionId: 'session-client' })
ok('strip renders once data arrives', stripTree !== null && stripTree !== undefined)
ok('strip reports the plan posture', texts(stripTree).includes('预检') && texts(stripTree).includes('待授权'))

// A plan with missing permissions opens the panel by itself.
const autoPanel = panel.component({})
ok('panel auto-opens when permissions are missing', autoPanel !== null && autoPanel !== undefined)
const closeButton = findByClass(autoPanel, 'dshap-icon-btn')
ok('panel exposes a close control', closeButton !== null)
closeButton.props.onClick()
ok('closing hides the panel', panel.component({}) === null)

// The strip toggles it back open.
const openButton = findByClass(stripTree, 'dshap-strip-btn')
ok('strip exposes an open control', openButton !== null && typeof openButton.props.onClick === 'function')
openButton.props.onClick()

const panelTree = panel.component({})
ok('panel renders after opening', panelTree !== null && panelTree !== undefined)
const panelText = texts(panelTree)
ok('panel shows the goal', panelText.includes('离线渲染验证'))
ok('panel shows the permission class', panelText.includes('执行命令'))
ok('panel shows the task rows', panelText.includes('T1') && panelText.includes('T2'))
ok('panel offers a grant control', findButtonWithText(panelTree, '全部授权') !== null || findButtonWithText(panelTree, '授权') !== null)

// Clicking "grant all" must reach the Host channel.
const grantAll = findButtonWithText(panelTree, '全部授权')
ok('grant-all button present', grantAll !== null)
grantAll.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
ok('grant reached the Host', calls.some((call) => call.endpoint === 'grant' && Array.isArray(call.payload.classes) && call.payload.classes.includes('exec')))

function findButtonWithText(node, needle) {
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
