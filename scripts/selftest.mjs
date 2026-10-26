/**
 * Deterministic self-test for the approval-preflight decision logic.
 *
 * The plugin's pure modules (classes, plan, state) do not import any Harness
 * package, so the two behaviours that decide whether the plugin is worth anything
 * can be verified without a running Host or a human clicking an approval card:
 *
 *  1. an approval request whose permission class is already granted is answered
 *     `allowed-once` without ever delegating to the native answerer;
 *  2. an ungranted request times out, is recorded as pending, injects "go do
 *     something else" guidance, and a late native answer still becomes a grant.
 *
 * Run: node scripts/selftest.mjs
 */

import assert from 'node:assert/strict'

import { classifyRequest } from '../lib/classes.js'
import { normalizeConfig } from '../lib/config.js'
import { normalizePlan, readinessOf, requiredClassesOf } from '../lib/plan.js'
import { createState } from '../lib/state.js'

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

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
console.log('classify')
equal('write -> fs-write', classifyRequest('write', { path: 'a.txt' }), 'fs-write')
equal('edit -> fs-write', classifyRequest('edit', {}), 'fs-write')
equal('pwsh -> exec', classifyRequest('pwsh', { command: 'ls' }), 'exec')
equal('terminal_read -> exec', classifyRequest('terminal_read', {}), 'exec')
equal('web_fetch -> network', classifyRequest('web_fetch', { url: 'https://x' }), 'network')
equal('danger-full-access wins', classifyRequest('pwsh', { sandbox_permissions: 'danger-full-access' }), 'danger')
equal('own tools are never approvals', classifyRequest('preflight_plan', {}), null)
equal('unknown tool stays unclassified', classifyRequest('some_mcp_tool', {}), null)

// ---------------------------------------------------------------------------
console.log('plan')
const normalized = normalizePlan(
  {
    goal: 'ship it',
    tasks: [
      { id: 'T1', title: 'read', needs: [] },
      { id: 'T2', title: 'write', needs: ['fs-write'], dependsOn: ['T1'] },
      { id: 'T3', title: 'network', needs: ['network'], dependsOn: ['T2'] }
    ]
  },
  40
)
ok('plan validates', normalized.ok)
equal('required classes', requiredClassesOf(normalized.plan, ['fs-write', 'exec', 'network', 'danger']).join(','), 'fs-write,network')
const readiness = readinessOf(normalized.plan, new Set())
ok('T1 ready with no grants', readiness.get('T1').ready)
ok('T2 blocked by dependency', readiness.get('T2').ready === false)
const bad = normalizePlan({ goal: 'x', tasks: [{ id: 'T1', title: 'a', dependsOn: ['nope'] }] }, 40)
ok('dangling dependency rejected', bad.ok === false && bad.errors.some((line) => line.includes('nope')))

// ---------------------------------------------------------------------------
console.log('approval interpreter')

const injected = []
const fakeAgent = {
  id: 'session-selftest',
  session: { snapshotEvents: () => [] },
  inject: (message) => injected.push({ kind: 'inject', message }),
  followup: (message) => injected.push({ kind: 'followup', message })
}

const fakeCtx = {
  logger: () => ({ info() {}, warn() {} }),
  agents: { get: (id) => (id === fakeAgent.id ? fakeAgent : undefined) },
  approval: { overrideOf: () => 'ask' }
}

const config = normalizeConfig({
  approvalTimeoutSeconds: 1,
  enabledClasses: ['fs-write', 'exec', 'network', 'danger'],
  maxTasks: 40,
  wakeOnGrant: true
})
const state = createState(fakeCtx, config)

// 1. granted class: answered instantly, native answerer never sees it
let delegated = 0
state.rememberCall({ agent: fakeAgent, callId: 'call-exec', name: 'pwsh', arguments: { command: 'pnpm test' } })
state.grant(fakeAgent.id, ['exec'])
const instant = await state.decideApproval(
  { agent: fakeAgent, toolName: 'pwsh', callId: 'call-exec' },
  () => {
    delegated += 1
    return Promise.resolve('rejected')
  }
)
equal('granted exec -> allowed-once', instant, 'allowed-once')
equal('native answerer not delegated to', delegated, 0)

// 2. ungranted class: timeout yields rejected + pending + guidance
const neverAnswers = deferred()
const started = Date.now()
const timedOut = await state.decideApproval(
  { agent: fakeAgent, toolName: 'web_fetch', callId: 'call-network' },
  () => neverAnswers.promise
)
const elapsed = Date.now() - started
equal('ungranted network -> rejected after timeout', timedOut, 'rejected')
ok(`timeout honoured (${elapsed}ms)`, elapsed >= 900)
ok(
  'guidance injected into the next step',
  injected.some((entry) => entry.kind === 'inject' && entry.message.content[0].text.includes('审批等待超时'))
)
const pendingView = state.panelView(fakeAgent.id)
ok('pending row visible in the panel', pendingView.classes.find((row) => row.id === 'network')?.pending === true)

// 3. the user answers the native card late: that click becomes a standing grant
neverAnswers.resolve('allowed-once')
await tick()
await tick()
const afterLate = state.panelView(fakeAgent.id)
ok('late native answer promoted to a grant', afterLate.classes.find((row) => row.id === 'network')?.granted === true)
ok(
  'late grant wakes the model',
  injected.some((entry) => entry.kind === 'followup' && entry.message.content[0].text.includes('preflight:grant'))
)

// 4. grant survives re-hydration from the log (injected message is durable)
const replayAgent = {
  id: 'session-replay',
  session: {
    snapshotEvents: () => [
      {
        type: 'tool/call',
        time: Date.now(),
        data: {
          name: 'preflight_plan',
          arguments: JSON.stringify({ goal: 'replay', tasks: [{ id: 'T1', title: 'a', needs: ['fs-write'] }] })
        }
      },
      {
        type: 'agent/inbox/spliced',
        time: Date.now(),
        data: {
          inserted: [{ role: 'user', content: [{ type: 'text', text: '[[preflight:grant:fs-write]] 用户已授权' }] }]
        }
      }
    ]
  },
  inject() {},
  followup() {}
}
const replayCtx = { ...fakeCtx, agents: { get: (id) => (id === replayAgent.id ? replayAgent : undefined) } }
const replayState = createState(replayCtx, config)
const replayView = replayState.panelView(replayAgent.id)
ok('plan rebuilt from tool/call events', replayView.tasks.length === 1 && replayView.goal === 'replay')
ok('grant rebuilt from injected message', replayView.classes.find((row) => row.id === 'fs-write')?.granted === true)

// 5. the legacy marker written by an earlier build still parses (seen in the
//    wild: `[[preflight:grant]]:fs-write,exec,network ...`)
const legacyAgent = {
  id: 'session-legacy',
  session: {
    snapshotEvents: () => [
      {
        type: 'agent/inbox/spliced',
        time: Date.now(),
        data: {
          inserted: [
            {
              role: 'user',
              content: [{ type: 'text', text: '[[preflight:grant]]:fs-write,exec,network 用户已在预检面板授权：写文件、执行命令、联网访问。' }]
            }
          ]
        }
      }
    ]
  },
  inject() {},
  followup() {}
}
const legacyState = createState({ ...fakeCtx, agents: { get: (id) => (id === legacyAgent.id ? legacyAgent : undefined) } }, config)
const legacyView = legacyState.panelView('session-legacy')
ok(
  'legacy grant marker still rehydrates',
  ['fs-write', 'exec', 'network'].every((id) => legacyView.classes.find((row) => row.id === id)?.granted === true)
)

// 6. an empty task list retires the table
const clearAgent = { id: 'session-clear', session: { snapshotEvents: () => [] }, inject() {}, followup() {} }
const clearState = createState({ ...fakeCtx, agents: { get: (id) => (id === clearAgent.id ? clearAgent : undefined) } }, config)
ok('plan registers', clearState.setPlan(clearAgent, { goal: 'x', tasks: [{ id: 'T1', title: 'a' }] }).ok === true)
const cleared = clearState.setPlan(clearAgent, { tasks: [] })
ok('empty task list clears the plan', cleared.ok === true && cleared.cleared === true)
ok('panel shows no stale tasks', clearState.panelView('session-clear').tasks.length === 0)

console.log(`\n${checks} checks passed`)