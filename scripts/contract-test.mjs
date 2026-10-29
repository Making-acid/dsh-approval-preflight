/**
 * Offline contract test for the Host entry point.
 *
 * `scripts/selftest.mjs` covers the pure decision logic; this file covers the
 * wiring that only fails at activation time in the real app:
 *
 *  - the exported `inject` list contains every service the code touches;
 *  - all five tools register with a usable output definition;
 *  - the prompt section is contributed;
 *  - `tools/pre-execute`, `tools/result` and `approval/request` (prepended) are
 *    registered, and an approval requested while a node runs is answered without
 *    delegating;
 *  - the panel route registers on `webServer`, enforces the admission fence, and
 *    round-trips the real `client-request` / `server-response` envelope;
 *  - activation still succeeds when the optional web services are absent.
 *
 * Run: node scripts/contract-test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, inject as injectList, name as pluginName } from '../index.js'
import { VERSION } from '../lib/version.js'

let checks = 0
function ok(label, condition) {
  checks += 1
  assert.ok(condition, label)
  console.log(`  ok  ${label}`)
}

function equal(label, actual, expected) {
  checks += 1
  assert.equal(actual, expected, `${label} (got ${JSON.stringify(actual)})`)
  console.log(`  ok  ${label}`)
}

function fakeAgent(id) {
  const agent = {
    id,
    session: { snapshotEvents: () => [] },
    followups: [],
    injects: [],
    inject(message) {
      agent.injects.push(message)
    },
    followup(message) {
      agent.followups.push(message)
    }
  }
  return agent
}

function fakeRequest(url, envelope) {
  const request = new EventEmitter()
  request.url = url
  setImmediate(() => {
    request.emit('data', Buffer.from(JSON.stringify(envelope)))
    request.emit('end')
  })
  return request
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(text) {
      this.body = text ?? ''
    }
  }
}

/**
 * Minimal Cordis stand-in. Reading a service property requires that service to be
 * declared for the current fiber, and `ctx.inject(deps, cb)` starts a nested fiber
 * whose declarations are `deps` — the same rules the real runtime enforces.
 */
function fakeContext({ withWeb = true } = {}) {
  const agents = new Map()
  const tools = []
  const sections = []
  const listeners = new Map()
  const routes = []

  const services = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      }
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      }
    },
    agents: { get: (id) => agents.get(id) },
    approval: { overrideOf: () => 'ask' }
  }
  if (withWeb) {
    services.connection = { admit: () => ({ peer: {} }) }
    services.webServer = {
      register(route) {
        routes.push(route)
        return () => {}
      }
    }
  }

  function buildScope(declared) {
    const base = {
      ...services,
      effect(callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      on(event, listener, options) {
        listeners.set(event, [...(listeners.get(event) ?? []), { listener, options }])
        return () => {}
      },
      inject(deps, callback) {
        for (const dep of deps) if (!(dep in services)) return // waits for a service that never arrives
        callback(buildScope(new Set([...declared, ...deps])))
      },
      get(serviceName) {
        if (!declared.has(serviceName)) throw new Error(`cannot get property "${serviceName}" without inject`)
        return services[serviceName]
      }
    }
    return new Proxy(base, {
      get(target, property) {
        if (typeof property === 'string' && property in services && !declared.has(property)) {
          throw new Error(`cannot get property "${property}" without inject`)
        }
        return target[property]
      }
    })
  }

  return { scope: buildScope(new Set(injectList)), agents, tools, sections, listeners, routes }
}

// ---------------------------------------------------------------------------
console.log('manifest')
equal('plugin name', pluginName, 'approval-preflight')
for (const required of ['tools', 'systemPrompt', 'agents', 'approval']) {
  ok(`inject declares ${required}`, injectList.includes(required))
}

// ---------------------------------------------------------------------------
console.log('activation (web profile)')
const wired = fakeContext({ withWeb: true })
const agent = fakeAgent('session-contract')
wired.agents.set(agent.id, agent)
apply(wired.scope, { approvalTimeoutSeconds: 30, nodeIdleSeconds: 60 })

equal('five tools registered', wired.tools.length, 5)
equal(
  'tools are the documented ones',
  wired.tools.map((tool) => tool.name).sort().join(','),
  'preflight_graph,preflight_graph_append,preflight_node_end,preflight_node_start,preflight_status'
)
ok('every tool has an output definition', wired.tools.every((tool) => tool.output?.schema !== undefined && typeof tool.output.render === 'function'))
equal('prompt section contributed', wired.sections.length, 1)
ok('prompt section names the graph workflow', wired.sections[0].text.includes('preflight_graph'))

const approvalListener = wired.listeners.get('approval/request')?.[0]
ok('approval/request listener registered', approvalListener !== undefined)
equal('approval listener prepends', approvalListener.options?.prepend, true)
ok('pre-execute listener registered', wired.listeners.get('tools/pre-execute')?.length === 1)
ok('tools/result listener registered', wired.listeners.get('tools/result')?.length === 1)
equal('panel route registered', wired.routes.length, 1)
equal('panel route path', wired.routes[0].path, '/dsh-approval-preflight')

// ---------------------------------------------------------------------------
console.log('graph -> panel -> approve -> run -> auto-allow')
const byName = new Map(wired.tools.map((tool) => [tool.name, tool]))
const graphTool = byName.get('preflight_graph')
const graphResult = await graphTool.execute(
  {
    goal: 'contract',
    nodes: [
      { id: 'N1', title: 'read', effect: 'read' },
      { id: 'N2', title: 'download', effect: 'download', action: '下载', source: 'npm', target: '依赖目录', dependsOn: ['N1'] },
      { id: 'N3', title: 'write', effect: 'write', target: 'src/x.ts', dependsOn: ['N2'] }
    ]
  },
  { agent, callId: 'c-graph' }
)
ok('graph tool returns ok', graphResult.ok === true)
equal('pending node reported', graphResult.pending.join(','), 'N2,N3')

const route = wired.routes[0]
async function callRoute(endpoint, payload) {
  const response = fakeResponse()
  await route.handler(
    fakeRequest(`/dsh-approval-preflight/${endpoint}`, { type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload }),
    response
  )
  return { status: response.status, body: JSON.parse(response.body) }
}

const statusCall = await callRoute('status', { sessionId: agent.id })
equal('status route answers', statusCall.status, 200)
ok('status envelope shape', statusCall.body.type === 'server-response' && statusCall.body.result.ok === true)
equal('status lists the graph nodes', statusCall.body.result.value.nodes.length, 3)
equal('status reports the loaded plugin version', statusCall.body.result.value.plugin?.version, VERSION)
equal('status advertises the panel protocol', statusCall.body.result.value.plugin?.protocol, 2)
const pingCall = await callRoute('ping', {})
ok('ping answers without a session', pingCall.body.result.ok === true && pingCall.body.result.value.version === VERSION)
ok('status tool reports the plugin version', (await wired.tools.find((tool) => tool.name === 'preflight_status').execute({}, { agent, callId: 'c-status' })).pluginVersion === VERSION)

const approveCall = await callRoute('approve', { sessionId: agent.id, nodeIds: ['N2'] })
ok('approve accepted', approveCall.body.result.ok === true && approveCall.body.result.value.approved.join(',') === 'N2')
ok('approval wakes the model', agent.followups.length === 1)
ok('approval notice is machine readable', agent.followups[0].content[0].text.includes('[[preflight:approve:1:N2]]'))

const startTool = byName.get('preflight_node_start')
const endTool = byName.get('preflight_node_end')
ok('read node starts', (await startTool.execute({ id: 'N1' }, { agent, callId: 'c-s1' })).ok === true)
ok('read node ends', (await endTool.execute({ id: 'N1', success: true }, { agent, callId: 'c-e1' })).ok === true)
ok('approved node starts', (await startTool.execute({ id: 'N2' }, { agent, callId: 'c-s2' })).ok === true)

// a matching call is classified through the pre-execute record and answered
const preExecute = wired.listeners.get('tools/pre-execute')[0].listener
await preExecute({ agent, callId: 'call-net', name: 'web_fetch', arguments: { url: 'https://registry.npmjs.org/x' } }, () => Promise.resolve('allow'))
let delegated = 0
const outcome = await approvalListener.listener({ agent, toolName: 'web_fetch', callId: 'call-net' }, () => {
  delegated += 1
  return Promise.resolve('rejected')
})
equal('covered call short-circuits to allowed-once', outcome, 'allowed-once')
equal('native answerer untouched', delegated, 0)

// a call outside the node's declaration is never auto-approved
await preExecute({ agent, callId: 'call-exec', name: 'pwsh', arguments: { command: 'rm -rf /tmp/x' } }, () => Promise.resolve('allow'))
let delegatedExec = 0
await approvalListener.listener({ agent, toolName: 'pwsh', callId: 'call-exec' }, () => {
  delegatedExec += 1
  return Promise.resolve('rejected')
})
ok('uncovered impact delegates to the native card', delegatedExec === 1)

// finishing the node consumes the approval
await endTool.execute({ id: 'N2', success: true }, { agent, callId: 'c-e2' })
const afterRun = await callRoute('status', { sessionId: agent.id })
equal('node done in the panel', afterRun.body.result.value.nodes.find((node) => node.id === 'N2').status, 'done')
ok('audit recorded', afterRun.body.result.value.nodes.find((node) => node.id === 'N2').audit.length >= 1)

// ---------------------------------------------------------------------------
console.log('degradation (no web carrier)')
const headless = fakeContext({ withWeb: false })
apply(headless.scope, {})
equal('tools still register without web services', headless.tools.length, 5)
equal('no route registered', headless.routes.length, 0)
ok('approval listener still registered', headless.listeners.get('approval/request')?.length === 1)

console.log(`\n${checks} checks passed`)
