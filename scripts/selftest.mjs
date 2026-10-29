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
import { normalizeAppend, normalizeGraph, readinessOf } from '../lib/graph.js'
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
ok('timeout explains itself to the model', injected.some((entry) => entry.kind === 'inject' && entry.message.content[0].text.includes('没有覆盖这次调用')))

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

const readiness = readinessOf(normalized.graph.nodes[2], new Map([
  ['N1', { status: 'done' }],
  ['N2', { status: 'done' }],
  ['N3', { status: 'proposed' }]
]))
ok('readiness waits for approval', readiness.ready === false && readiness.blockedBy === '待批准')

console.log(`\n${checks} checks passed`)
