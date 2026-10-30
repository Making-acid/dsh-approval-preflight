/**
 * Deterministic self-test for the graph + node authorization model.
 *
 * The pure modules (impacts, graph, state) do not import any Harness package, so
 * the behaviours that decide whether the plugin is worth anything can be verified
 * without a running Host:
 *
 *  - a node is approved per node, not per permission class;
 *  - a call is auto-approved only while an approved node is running and the
 *    call's impact kind is inside that node's declaration;
 *  - success consumes the approval, failure restores it (retry without re-asking);
 *  - graph / approvals / node windows / audit replay from the session log, and an
 *    approval from an older graph version never applies (fail closed).
 *
 * Run: node scripts/selftest.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { normalizeConfig } from '../lib/config.js'
import { dependencyClosure, dependentsOf, normalizeAppend, normalizeGraph, readinessOf } from '../lib/graph.js'
import { defaultImpacts, impactOfCall, needsEscalation, summarizeCall } from '../lib/impacts.js'
import { createState } from '../lib/state.js'
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

const never = () => new Promise(() => {})

// ---------------------------------------------------------------------------
console.log('identity')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
equal('lib/version.js matches package.json', VERSION, pkg.version)
equal('package name matches the plugin', pkg.name, 'dsh-approval-preflight')
ok('package still declares the bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
ok('package still declares the client half', pkg.dsh?.client?.platform === 'web')

// ---------------------------------------------------------------------------
console.log('impacts')
equal('write -> fs-write', impactOfCall('write', { path: 'a.ts' }), 'fs-write')
equal('edit -> fs-write', impactOfCall('edit', {}), 'fs-write')
equal('pwsh -> exec', impactOfCall('pwsh', { command: 'ls' }), 'exec')
equal('web_fetch -> network', impactOfCall('web_fetch', { url: 'https://x' }), 'network')
equal('own tools never approvals', impactOfCall('preflight_graph', {}), null)
equal('mcp tools unclassified', impactOfCall('some_mcp_tool', {}), null)
ok('escalation detected', needsEscalation({ sandbox_permissions: 'danger-full-access' }))
equal('download defaults', defaultImpacts('download').join(','), 'network,fs-write')
ok('summary keeps the command', summarizeCall('pwsh', { command: 'pnpm test' }).includes('pnpm test'))

// ---------------------------------------------------------------------------
console.log('graph')
const rawGraph = {
  goal: '给项目加 SQLite 支持',
  nodes: [
    { id: 'N1', title: '读依赖清单', effect: 'read' },
    { id: 'N2', title: '下载 better-sqlite3', effect: 'download', action: '下载', source: 'npm registry', target: '依赖目录', dependsOn: ['N1'] },
    { id: 'N3', title: '写封装', effect: 'write', target: 'src/db.ts', dependsOn: ['N2'] }
  ]
}
const normalized = normalizeGraph(rawGraph, 40)
ok('graph validates', normalized.ok)
equal('graph node count', normalized.graph.nodes.length, 3)
equal('download node impacts', normalized.graph.nodes[1].impacts.join(','), 'network,fs-write')
equal('read node needs no permission', normalized.graph.nodes[0].permission, 'none')
ok('dangling dependency rejected', normalizeGraph({ goal: 'x', nodes: [{ id: 'N1', title: 'a', dependsOn: ['nope'] }] }, 40).ok === false)
ok('duplicate id rejected', normalizeGraph({ goal: 'x', nodes: [{ id: 'N1', title: 'a' }, { id: 'N1', title: 'b' }] }, 40).ok === false)
const appended = normalizeAppend(normalized.graph, [{ id: 'N4', title: '跑构建', effect: 'execute' }], 40)
ok('append works', appended.ok && appended.nodes[0].id === 'N4')
ok('append rejects duplicate', normalizeAppend(normalized.graph, [{ id: 'N1', title: 'dup' }], 40).ok === false)
ok('dependency cycle is rejected', normalizeGraph({
  goal: 'cycle',
  nodes: [
    { id: 'A', title: 'a', dependsOn: ['B'] },
    { id: 'B', title: 'b', dependsOn: ['A'] }
  ]
}, 40).ok === false)
const closure = dependencyClosure(normalized.graph, 'N3')
ok('dependency closure is transitive', closure.has('N2') && closure.has('N1') && closure.size === 2)
equal('dependents point the other way', dependentsOf(normalized.graph, 'N1').join(','), 'N2')

// ---------------------------------------------------------------------------
console.log('state machine')

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
const config = normalizeConfig({ approvalTimeoutSeconds: 1, nodeIdleSeconds: 30, maxNodes: 40, wakeOnGrant: true })
const state = createState(fakeCtx, config)

const registered = state.setGraph(fakeAgent, rawGraph)
ok('setGraph ok', registered.ok === true)
equal('graph version starts at 1', state.panelView(fakeAgent.id).version, 1)
const afterGraph = state.panelView(fakeAgent.id)
equal('read node auto-approved', afterGraph.nodes.find((node) => node.id === 'N1').status, 'approved')
equal('write node waits for approval', afterGraph.nodes.find((node) => node.id === 'N3').status, 'proposed')

ok('cannot start an unapproved node', state.startNode(fakeAgent, 'N2').ok === false)

const approved = state.approveNodes(fakeAgent.id, ['N2'])
equal('approve accepts the node', approved.approved.join(','), 'N2')
ok('approval wakes the model', injected.some((entry) => entry.kind === 'followup'))
ok('approval marker is durable-readable', injected.some((entry) => entry.message.content[0].text.includes('[[preflight:approve:1:N2]]')))

ok('read node starts', state.startNode(fakeAgent, 'N1').ok === true)
ok('read node ends', state.endNode(fakeAgent, 'N1', true).ok === true)
ok('approved node starts', state.startNode(fakeAgent, 'N2').ok === true)
ok('only one node may run', state.startNode(fakeAgent, 'N3').ok === false)

// covered call: impact inside the running node's declaration
state.rememberCall({ agent: fakeAgent, callId: 'call-net', name: 'web_fetch', arguments: { url: 'https://registry.npmjs.org/better-sqlite3' } })
let delegated = 0
const covered = await state.decideApproval({ agent: fakeAgent, toolName: 'web_fetch', callId: 'call-net' }, () => {
  delegated += 1
  return Promise.resolve('rejected')
})
equal('covered call -> allowed-once', covered, 'allowed-once')
equal('native answerer untouched', delegated, 0)

// uncovered impact inside the same node: exec is not in a download node
state.rememberCall({ agent: fakeAgent, callId: 'call-exec', name: 'pwsh', arguments: { command: 'rm -rf /tmp/x' } })
const startedAt = Date.now()
const uncovered = await state.decideApproval({ agent: fakeAgent, toolName: 'pwsh', callId: 'call-exec' }, never)
ok(`uncovered call -> rejected after timeout (${Date.now() - startedAt}ms)`, uncovered === 'rejected' && Date.now() - startedAt >= 900)

// the blocked node is released, not killed: its approval survives
const afterTimeout = state.panelView(fakeAgent.id)
equal('timeout suspends the blocked node', afterTimeout.nodes.find((node) => node.id === 'N2').status, 'suspended')
equal('timeout frees the running slot', afterTimeout.running, null)
ok('suspension reason reaches the panel', afterTimeout.nodes.find((node) => node.id === 'N2').suspendReason.includes('审批超时'))
const suspendNotice = injected
  .filter((entry) => entry.kind === 'inject')
  .map((entry) => entry.message.content[0].text)
  .filter((text) => text.includes('已自动挂起'))
  .pop()
ok('timeout explains the suspension to the model', suspendNotice !== undefined && suspendNotice.includes('不要重试'))
ok('timeout names the dependents that must wait', suspendNotice.includes('N3 依赖 N2'))
ok('suspension marker is replayable', suspendNotice.includes('[[preflight:suspend:1:N2]]'))
const endWhileSuspended = state.endNode(fakeAgent, 'N2', true)
ok('ending a suspended node explains resume instead', endWhileSuspended.ok === false && endWhileSuspended.reason.includes('preflight_node_start'))
ok('suspended node resumes without re-approval', state.startNode(fakeAgent, 'N2').ok === true)

// audit records what ran inside the window
state.auditCall({ agent: fakeAgent, callId: 'call-net', name: 'web_fetch', arguments: { url: 'https://registry.npmjs.org/better-sqlite3' } })
state.noteResult({ agent: fakeAgent, callId: 'call-net' }, { isError: false })
const auditNode = state.panelView(fakeAgent.id).nodes.find((node) => node.id === 'N2')
ok('audit entry recorded with outcome', auditNode.audit.some((entry) => entry.tool === 'web_fetch' && entry.outcome === 'ok'))

// success consumes the approval; a later call is delegated again
ok('node ends successfully', state.endNode(fakeAgent, 'N2', true).ok === true)
equal('success marks the node done', state.panelView(fakeAgent.id).nodes.find((node) => node.id === 'N2').status, 'done')
state.rememberCall({ agent: fakeAgent, callId: 'call-after', name: 'web_fetch', arguments: { url: 'https://x' } })
let delegatedAfter = 0
await state.decideApproval({ agent: fakeAgent, toolName: 'web_fetch', callId: 'call-after' }, () => {
  delegatedAfter += 1
  return Promise.resolve('rejected')
})
equal('consumed approval no longer applies', delegatedAfter, 1)

// failure restores the approval for a retry
state.approveNodes(fakeAgent.id, ['N3'])
ok('N3 starts', state.startNode(fakeAgent, 'N3').ok === true)
ok('N3 fails', state.endNode(fakeAgent, 'N3', false).ok === true)
equal('failure restores approval', state.panelView(fakeAgent.id).nodes.find((node) => node.id === 'N3').status, 'approved')
ok('failed node can be retried without re-approval', state.startNode(fakeAgent, 'N3').ok === true)
state.endNode(fakeAgent, 'N3', true)

// append keeps existing approvals
const beforeAppend = state.panelView(fakeAgent.id).nodes.find((node) => node.id === 'N2').status
const appendedState = state.appendGraph(fakeAgent, [{ id: 'N9', title: '追加步骤', effect: 'write', target: 'x' }])
ok('append adds a proposed node', appendedState.ok === true && state.panelView(fakeAgent.id).nodes.find((node) => node.id === 'N9').status === 'proposed')
equal('append keeps existing node status', state.panelView(fakeAgent.id).nodes.find((node) => node.id === 'N2').status, beforeAppend)

// ---------------------------------------------------------------------------
console.log('independent-branch switch')

// A fast timeout state: the switch decision is the same code, only the clock is shorter.
const switchInjected = []
const switchAgent = {
  id: 'session-switch',
  session: { snapshotEvents: () => [] },
  inject: (message) => switchInjected.push(message),
  followup: (message) => switchInjected.push(message)
}
const switchState = createState({
  logger: () => ({ info() {}, warn() {} }),
  agents: { get: (id) => (id === switchAgent.id ? switchAgent : undefined) },
  approval: { overrideOf: () => 'ask' }
}, { approvalTimeoutSeconds: 0.05, nodeIdleSeconds: 60, maxNodes: 40, wakeOnGrant: true })

ok('switch graph registered', switchState.setGraph(switchAgent, {
  goal: '切换测试',
  nodes: [
    { id: 'A', title: '主线：写配置', effect: 'write', target: 'config.json' },
    { id: 'B', title: '独立：更新文档', effect: 'write', target: 'README.md' },
    { id: 'C', title: '发布', effect: 'execute', dependsOn: ['A'] }
  ]
}).ok === true)
switchState.approveNodes(switchAgent.id, ['A', 'B'])
ok('main node starts', switchState.startNode(switchAgent, 'A').ok === true)
switchState.rememberCall({ agent: switchAgent, callId: 'sw1', name: 'pwsh', arguments: { command: 'git push' } })
const switchStarted = Date.now()
const switchOutcome = await switchState.decideApproval({ agent: switchAgent, toolName: 'pwsh', callId: 'sw1' }, never)
ok(`uncovered call fails fast (${Date.now() - switchStarted}ms)`, switchOutcome === 'rejected' && Date.now() - switchStarted < 500)

const switchView = switchState.panelView(switchAgent.id)
equal('blocked node suspended', switchView.nodes.find((node) => node.id === 'A').status, 'suspended')
equal('independent approved node is switchable', switchView.switchable.join(','), 'B')
ok('dependent node reports the suspended prerequisite', switchView.nodes.find((node) => node.id === 'C').blockedBy.includes('已挂起'))
const switchNotice = switchInjected.map((message) => message.content[0].text).join('\n')
ok('switch notice names B as the next step', switchNotice.includes('preflight_node_start B'))
ok('switch notice keeps A resumable', switchNotice.includes('preflight_node_start A'))
ok('switch notice never offers the dependent node', switchNotice.includes('C 依赖 A'))
ok('independent node starts while A is suspended', switchState.startNode(switchAgent, 'B').ok === true)
ok('independent node ends', switchState.endNode(switchAgent, 'B', true).ok === true)
ok('suspended node resumes after the independent branch', switchState.startNode(switchAgent, 'A').ok === true)
equal('resume keeps the one-shot approval', switchState.panelView(switchAgent.id).nodes.find((node) => node.id === 'A').resumeCount, 1)

// ---------------------------------------------------------------------------
console.log('log replay')

function replayAgent(events) {
  return {
    id: 'session-replay',
    session: { snapshotEvents: () => events },
    inject() {},
    followup() {}
  }
}
const graphArgs = JSON.stringify(rawGraph)
const replayEvents = [
  { type: 'tool/call', time: 1, data: { name: 'preflight_graph', callId: 'c0', arguments: graphArgs } },
  { type: 'tool/call', time: 2, data: { name: 'preflight_node_start', callId: 'c1', arguments: JSON.stringify({ id: 'N1' }) } },
  { type: 'tool/call', time: 3, data: { name: 'preflight_node_end', callId: 'c2', arguments: JSON.stringify({ id: 'N1', success: true }) } },
  { type: 'user/message', time: 4, data: { role: 'user', content: [{ type: 'text', text: '[[preflight:approve:1:N2]] 用户已批准' }] } },
  { type: 'tool/call', time: 5, data: { name: 'preflight_node_start', callId: 'c3', arguments: JSON.stringify({ id: 'N2' }) } },
  { type: 'tool/call', time: 6, data: { name: 'web_fetch', callId: 'c4', arguments: JSON.stringify({ url: 'https://registry.npmjs.org/x' }) } },
  { type: 'tool/result', time: 7, data: { turn: 1, step: 2, message: { toolCallId: 'c4' } } },
  { type: 'tool/call', time: 8, data: { name: 'preflight_node_end', callId: 'c5', arguments: JSON.stringify({ id: 'N2', success: true }) } }
]
const replay = replayAgent(replayEvents)
const replayCtx = { ...fakeCtx, agents: { get: (id) => (id === replay.id ? replay : undefined) } }
const replayState = createState(replayCtx, config)
const replayView = replayState.panelView(replay.id)
ok('graph rebuilt from tool/call', replayView.hasGraph && replayView.goal === '给项目加 SQLite 支持')
equal('node window replayed: N1 done', replayView.nodes.find((node) => node.id === 'N1').status, 'done')
equal('approval replayed: N2 done', replayView.nodes.find((node) => node.id === 'N2').status, 'done')
ok('audit replayed with outcome', replayView.nodes.find((node) => node.id === 'N2').audit.some((entry) => entry.tool === 'web_fetch' && entry.outcome === 'ok'))

const staleEvents = [
  { type: 'tool/call', time: 1, data: { name: 'preflight_graph', callId: 'c0', arguments: graphArgs } },
  { type: 'tool/call', time: 2, data: { name: 'preflight_graph', callId: 'c1', arguments: graphArgs } },
  { type: 'user/message', time: 3, data: { role: 'user', content: [{ type: 'text', text: '[[preflight:approve:1:N2]] 旧版本的批准' }] } }
]
const stale = replayAgent(staleEvents)
const staleState = createState({ ...fakeCtx, agents: { get: (id) => (id === stale.id ? stale : undefined) } }, config)
equal('approval from an older graph version is ignored', staleState.panelView(stale.id).nodes.find((node) => node.id === 'N2').status, 'proposed')

// a suspension is durable: the injected marker replays the released slot, and a
// later node_start replays the resume
const suspendEvents = [
  { type: 'tool/call', time: 1, data: { name: 'preflight_graph', callId: 'r0', arguments: graphArgs } },
  { type: 'user/message', time: 2, data: { role: 'user', content: [{ type: 'text', text: '[[preflight:approve:1:N2]] ok' }] } },
  { type: 'tool/call', time: 3, data: { name: 'preflight_node_start', callId: 'r1', arguments: JSON.stringify({ id: 'N2' }) } },
  { type: 'agent/inbox/spliced', time: 4, data: { inserted: [{ role: 'user', content: [{ type: 'text', text: '⏸ 已自动挂起 [[preflight:suspend:1:N2]]' }] }] } }
]
const frozen = replayAgent(suspendEvents)
const frozenState = createState({ ...fakeCtx, agents: { get: (id) => (id === frozen.id ? frozen : undefined) } }, config)
const frozenView = frozenState.panelView(frozen.id)
equal('suspension replays as a released slot', frozenView.nodes.find((node) => node.id === 'N2').status, 'suspended')
equal('replayed suspension leaves nothing running', frozenView.running, null)

const resumedEvents = [
  ...suspendEvents,
  { type: 'tool/call', time: 5, data: { name: 'preflight_node_start', callId: 'r2', arguments: JSON.stringify({ id: 'N2' }) } }
]
const resumed = replayAgent(resumedEvents)
const resumedState = createState({ ...fakeCtx, agents: { get: (id) => (id === resumed.id ? resumed : undefined) } }, config)
equal('resume replays as running', resumedState.panelView(resumed.id).nodes.find((node) => node.id === 'N2').status, 'running')

const readiness = readinessOf(normalized.graph.nodes[2], new Map([
  ['N1', { status: 'done' }],
  ['N2', { status: 'done' }],
  ['N3', { status: 'proposed' }]
]))
ok('readiness waits for approval', readiness.ready === false && readiness.blockedBy === '待批准')

// Node-idle timers belong to the process; dispose every state so the suite exits now
// instead of waiting out the 30–60s idle windows left open by the last transitions.
for (const instance of [state, switchState, replayState, staleState, frozenState, resumedState]) {
  instance.disposeAll()
}

console.log(`\n${checks} checks passed`)
