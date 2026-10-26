/**
 * The computation graph: nodes, their semantic essence, and the impact kinds they
 * declare. This is what the user reviews; nothing here is code-level.
 */

import { defaultImpacts, defaultPermission, EFFECTS, IMPACT_LABELS, isEffect, isImpact } from './impacts.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/
const MAX_TITLE = 160
const MAX_GOAL = 400
const MAX_TEXT = 400

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/**
 * Normalize one raw node into the stored shape.
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ok: boolean, errors: string[], node?: object}}
 */
function normalizeNode(raw, index) {
  const errors = []
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const id = text(source.id, 16)
  if (!ID_PATTERN.test(id)) errors.push(`第 ${index + 1} 个节点 id 非法（1–16 位字母数字/-/_）：${id || '(空)'}`)
  const title = text(source.title, MAX_TITLE)
  if (!title) errors.push(`${id || `第 ${index + 1} 个节点`} 缺少 title`)
  const effect = isEffect(source.effect) ? source.effect : 'compute'
  const impacts = []
  const rawImpacts = Array.isArray(source.impacts) ? source.impacts : null
  if (rawImpacts === null) {
    for (const impact of defaultImpacts(effect)) impacts.push(impact)
  } else {
    for (const impact of rawImpacts) if (isImpact(impact) && !impacts.includes(impact)) impacts.push(impact)
  }
  const dependsOn = []
  if (Array.isArray(source.dependsOn)) {
    for (const dep of source.dependsOn) {
      if (typeof dep === 'string' && dep.trim().length > 0 && !dependsOn.includes(dep.trim())) dependsOn.push(dep.trim())
    }
  }
  const permission = source.permission === 'none' || source.permission === 'required'
    ? source.permission
    : defaultPermission(effect)
  const node = {
    id,
    title,
    effect,
    essence: {
      action: text(source.action, 40) || effect,
      source: text(source.source, MAX_TEXT),
      target: text(source.target, MAX_TEXT),
      details: text(source.details, MAX_TEXT)
    },
    note: text(source.note, MAX_TEXT),
    dependsOn,
    impacts,
    escalate: source.escalate === true,
    permission
  }
  return { ok: errors.length === 0, errors, node }
}

/**
 * Build a graph from tool arguments.
 * @param {unknown} raw
 * @param {number} maxNodes
 * @returns {{ok: boolean, errors: string[], graph?: object}}
 */
export function normalizeGraph(raw, maxNodes) {
  const errors = []
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const goal = text(source.goal, MAX_GOAL)
  if (!goal) errors.push('goal 不能为空')
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : []
  if (rawNodes.length === 0) errors.push('nodes 至少要有 1 项')
  if (rawNodes.length > maxNodes) errors.push(`nodes 最多 ${maxNodes} 项`)

  const nodes = []
  const seen = new Set()
  for (let index = 0; index < Math.min(rawNodes.length, maxNodes); index += 1) {
    const normalized = normalizeNode(rawNodes[index], index)
    for (const line of normalized.errors) errors.push(line)
    if (!normalized.node) continue
    if (seen.has(normalized.node.id)) {
      errors.push(`节点 id 重复：${normalized.node.id}`)
      continue
    }
    seen.add(normalized.node.id)
    nodes.push(normalized.node)
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!seen.has(dep)) errors.push(`${node.id} 依赖了不存在的节点：${dep}`)
      if (dep === node.id) errors.push(`${node.id} 不能依赖自己`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], graph: { goal, nodes, version: 0, at: Date.now() } }
}

/**
 * Append new nodes to an existing graph (no version bump, approvals survive).
 * @param {{nodes: object[]} | null} graph
 * @param {unknown} rawNodes
 * @param {number} maxNodes
 * @returns {{ok: boolean, errors: string[], nodes?: object[]}}
 */
export function normalizeAppend(graph, rawNodes, maxNodes) {
  const errors = []
  const list = Array.isArray(rawNodes) ? rawNodes : []
  if (list.length === 0) errors.push('nodes 至少要有 1 项')
  const existing = new Set((graph?.nodes ?? []).map((node) => node.id))
  if ((graph?.nodes?.length ?? 0) + list.length > maxNodes) errors.push(`节点总数最多 ${maxNodes}`)
  const nodes = []
  for (let index = 0; index < list.length; index += 1) {
    const normalized = normalizeNode(list[index], index)
    for (const line of normalized.errors) errors.push(line)
    if (!normalized.node) continue
    if (existing.has(normalized.node.id)) {
      errors.push(`节点 id 已存在：${normalized.node.id}`)
      continue
    }
    existing.add(normalized.node.id)
    nodes.push(normalized.node)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], nodes }
}

/**
 * Whether a node may start now: dependencies done and permission settled.
 * @param {object} node
 * @param {Map<string, {status: string}>} states
 * @returns {{ready: boolean, missingDeps: string[], blockedBy: string}}
 */
export function readinessOf(node, states) {
  const missingDeps = node.dependsOn.filter((dep) => states.get(dep)?.status !== 'done')
  if (missingDeps.length > 0) return { ready: false, missingDeps, blockedBy: `等前置 ${missingDeps.join('/')}` }
  const state = states.get(node.id)
  if (state === undefined) return { ready: false, missingDeps: [], blockedBy: '状态未知' }
  if (state.status === 'approved') return { ready: true, missingDeps: [], blockedBy: '' }
  if (state.status === 'done') return { ready: false, missingDeps: [], blockedBy: '已完成' }
  if (state.status === 'running') return { ready: false, missingDeps: [], blockedBy: '执行中' }
  if (state.status === 'rejected') return { ready: false, missingDeps: [], blockedBy: '已拒绝' }
  if (state.status === 'revoked') return { ready: false, missingDeps: [], blockedBy: '已撤销' }
  return { ready: false, missingDeps: [], blockedBy: '待批准' }
}

/**
 * Compact model-facing rendering of the graph.
 * @param {{goal: string, nodes: object[]} | null} graph
 * @param {Map<string, object>} states
 * @param {string | null} running
 * @returns {string}
 */
export function renderGraphText(graph, states, running) {
  if (!graph) return '当前会话还没有计算图。'
  const lines = [`目标：${graph.goal}`]
  for (const node of graph.nodes) {
    const state = states.get(node.id) ?? { status: 'proposed' }
    const readiness = readinessOf(node, states)
    const marks = []
    if (state.status === 'done') marks.push('已完成')
    else if (state.status === 'running') marks.push('执行中')
    else if (state.status === 'rejected') marks.push('已拒绝')
    else if (state.status === 'revoked') marks.push('已撤销')
    else if (readiness.ready) marks.push('可执行')
    else marks.push(readiness.blockedBy)
    const impacts = node.impacts.length > 0
      ? node.impacts.map((impact) => IMPACT_LABELS[impact] ?? impact).join('、')
      : '无外部影响'
    const essence = [node.essence.action, node.essence.source ? `来源 ${node.essence.source}` : '', node.essence.target ? `目标 ${node.essence.target}` : '']
      .filter(Boolean)
      .join(' · ')
    lines.push(`- ${node.id} ${node.title} [${marks.join('，')}]（${essence || '未描述'}；影响：${impacts}${node.escalate ? '；需提权' : ''}）`)
  }
  lines.push(running ? `当前执行中：${running}` : '当前没有执行中的节点。')
  return lines.join('\n')
}
