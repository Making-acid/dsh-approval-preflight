/**
 * Offline contract test for the Host entry point.
 *
 * `scripts/selftest.mjs` covers the pure decision logic. This file covers the
 * wiring that only fails at activation time in the real app — and therefore used
 * to require a restart to discover:
 *
 *  - the exported `inject` list contains every service the code touches
 *    (Cordis throws `cannot get property "x" without inject` otherwise);
 *  - all three tools register with a usable output definition;
 *  - the prompt section is contributed;
 *  - the `approval/request` listener is registered with `prepend` and answers a
 *    granted class with `allowed-once` without delegating;
 *  - the panel route registers on `webServer`, enforces the admission fence, and
 *    round-trips the real `client-request` / `server-response` envelope;
 *  - activation still succeeds when the optional web services are absent.
 *
 * Run: node scripts/contract-test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, inject as injectList, name as pluginName } from '../index.js'

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
    injected: [],
    followups: [],
    inject(message) {
      agent.injected.push(message)
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
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
    },
    end(text) {
      response.body = text ?? ''
    }
  }
  return response
}

/**
 * Minimal Cordis stand-in.
 *
 * Reproduces the two activation rules that only the real runtime enforces:
 *  - reading a service property requires that service to be declared for the
 *    current fiber (`cannot get property "x" without inject`);
 *  - `ctx.inject(deps, callback)` starts a *nested fiber* whose declarations are
 *    `deps` — the services need not appear in the plugin's top-level `inject`,
 *    and a dependency that never becomes available simply never runs the body.
 */
function fakeContext({ withWeb = true } = {}) {
  const agents = new Map()
  const tools = []
  const sections = []
  const listeners = new Map()
  const effects = []
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
        if (typeof disposer === 'function') effects.push(disposer)
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

  return {
    scope: buildScope(new Set(injectList)),
    agents,
    tools,
    sections,
    listeners,
    effects,
    routes
  }
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
apply(wired.scope, { approvalTimeoutSeconds: 30 })

equal('three tools registered', wired.tools.length, 3)
equal('tools are the documented ones', wired.tools.map((tool) => tool.name).sort().join(','), 'preflight_plan,preflight_status,preflight_task')
ok('every tool has an output definition', wired.tools.every((tool) => tool.output?.schema !== undefined && typeof tool.output.render === 'function'))
ok('tool parameters are object schemas', wired.tools.every((tool) => tool.parameters?.type === 'object'))
equal('prompt section contributed', wired.sections.length, 1)
ok('prompt section names the workflow', wired.sections[0].text.includes('preflight_plan'))

const approvalListener = wired.listeners.get('approval/request')?.[0]
ok('approval/request listener registered', approvalListener !== undefined)
equal('approval listener prepends', approvalListener.options?.prepend, true)
ok('pre-execute listener registered', wired.listeners.get('tools/pre-execute')?.length === 1)
equal('panel route registered', wired.routes.length, 1)
equal('panel route path', wired.routes[0].path, '/dsh-approval-preflight')
equal('panel route kind', wired.routes[0].kind, 'prefix')

// ---------------------------------------------------------------------------
console.log('plan tool -> panel -> grant -> auto-allow')
const planTool = wired.tools.find((tool) => tool.name === 'preflight_plan')
const statusTool = wired.tools.find((tool) => tool.name === 'preflight_status')
const executed = await planTool.execute(
  {
    goal: 'contract',
    tasks: [
      { id: 'T1', title: 'read', needs: [] },
      { id: 'T2', title: 'run tests', needs: ['exec'], dependsOn: ['T1'] }
    ]
  },
  { agent, callId: 'call-plan' }
)
ok('plan tool returns ok', executed.ok === true)
equal('missing class reported', executed.missing.join(','), 'exec')

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
ok('status envelope shape', statusCall.body.type === 'server-response' && statusCall.body.rpcId === 'rpc-1' && statusCall.body.result.ok === true)
equal('status lists the plan tasks', statusCall.body.result.value.tasks.length, 2)

const grantCall = await callRoute('grant', { sessionId: agent.id, classes: ['exec'] })
ok('grant accepted', grantCall.body.result.ok === true && grantCall.body.result.value.accepted.join(',') === 'exec')
ok('grant wakes the model', agent.followups.length === 1)
ok('grant notice is machine readable', agent.followups[0].content[0].text.includes('[[preflight:grant:exec]]'))

// a matching dispatched call is classified through the pre-execute record
const preExecute = wired.listeners.get('tools/pre-execute')[0].listener
await preExecute({ agent, callId: 'call-exec', name: 'pwsh', arguments: { command: 'pnpm test' } }, () => Promise.resolve('allow'))

let delegated = 0
const outcome = await approvalListener.listener(
  { agent, toolName: 'pwsh', callId: 'call-exec' },
  () => {
    delegated += 1
    return Promise.resolve('rejected')
  }
)
equal('granted exec short-circuits to allowed-once', outcome, 'allowed-once')
equal('native answerer untouched', delegated, 0)

const cleared = await statusTool.execute({}, { agent, callId: 'call-status' })
ok('status tool agrees the class is granted', cleared.granted.includes('exec'))

// ---------------------------------------------------------------------------
console.log('degradation (no web carrier)')
const headless = fakeContext({ withWeb: false })
apply(headless.scope, {})
equal('tools still register without web services', headless.tools.length, 3)
equal('no route registered', headless.routes.length, 0)
ok('approval listener still registered', headless.listeners.get('approval/request')?.length === 1)

console.log(`\n${checks} checks passed`)
