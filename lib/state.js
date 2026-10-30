/**
 * Per-session graph state: the computation graph, node status, the single running
 * node, node approvals, and the audit trail of what actually ran.
 *
 * Invariants:
 *  - Authority is a node, not a tool: a call is auto-approved only while an
 *    approved node is running and the call's impact kind is inside that node's
 *    declared impacts.
 *  - The session log is the source of truth: graph, approvals, node windows and
 *    audit are rebuilt from events, with a fail-closed fallback.
 *  - Nothing here may throw into a tool call or the approval waterfall.
 */

import { dependencyClosure, dependentsOf, normalizeAppend, normalizeGraph, readinessOf, renderGraphText } from './graph.js'
import { impactOfCall, needsEscalation, summarizeCall } from './impacts.js'
import { approveMarker, createUserMessage, parseApprovals, parseSuspensions, suspendMarker, textOf } from './messages.js'

const MAX_SESSIONS = 32
const MAX_CALLS = 256
const MAX_AUDIT = 40

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger('approval-preflight')
  } catch {
    /* fall through to the silent logger */
  }
  return null
}

/**
 * Create the activation-scoped state machine.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function createState(ctx, config) {
  const logger = resolveLogger(ctx)
  /** @type {Map<string, object>} */
  const sessions = new Map()

  function log(level, text) {
    const target = logger?.[level]
    if (typeof target !== 'function') return
    try {
      target.call(logger, text)
    } catch {
      /* logging must never break a request */
    }
  }

  function emptyState(sessionId) {
    return {
      id: sessionId,
      graph: null,
      nodeStates: new Map(),
      running: null,
      calls: new Map(),
      timers: new Set(),
      idleTimer: null,
      hydrated: false,
      lastSeen: Date.now()
    }
  }

  function ensure(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = emptyState(sessionId)
      sessions.set(sessionId, state)
      if (sessions.size > MAX_SESSIONS) {
        let oldestId
        let oldestAt = Infinity
        for (const [id, candidate] of sessions) {
          if (candidate.lastSeen < oldestAt) {
            oldestAt = candidate.lastSeen
            oldestId = id
          }
        }
        if (oldestId !== undefined && oldestId !== sessionId) dispose(oldestId)
      }
    }
    state.lastSeen = Date.now()
    return state
  }

  function agentOf(sessionId) {
    try {
      const agents = ctx.agents
      if (agents !== undefined && typeof agents.get === 'function') return agents.get(sessionId)
    } catch {
      /* an absent agent only means "no live session to notify" */
    }
    return undefined
  }

  function freshNodeState(node) {
    return {
      status: node.permission === 'none' ? 'approved' : 'proposed',
      approvedAt: 0,
      startedAt: 0,
      endedAt: 0,
      suspendedAt: 0,
      suspendReason: '',
      resumeCount: 0,
      audit: []
    }
  }

  function resetNodeStates(state, graph) {
    state.nodeStates = new Map()
    for (const node of graph.nodes) state.nodeStates.set(node.id, freshNodeState(node))
  }

  function appendNodeStates(state, nodes) {
    for (const node of nodes) state.nodeStates.set(node.id, freshNodeState(node))
  }

  function clearIdle(state) {
    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer)
      state.idleTimer = null
    }
  }

  function applyApprovals(state, text, at) {
    for (const approval of parseApprovals(text)) {
      if (state.graph === null) continue
      if (approval.version !== state.graph.version) continue // a stale plan's approval never applies
      const nodeState = state.nodeStates.get(approval.nodeId)
      if (nodeState === undefined || nodeState.status !== 'proposed') continue
      nodeState.status = 'approved'
      nodeState.approvedAt = at
    }
  }

  /**
   * Apply the durable suspension markers in one injected message.
   *
   * Idempotent by construction: a marker only acts on a node that is currently
   * running, so re-reading the same text cannot re-suspend a node already resumed.
   * @param {object} state
   * @param {string} text
   */
  function applySuspensions(state, text) {
    for (const suspension of parseSuspensions(text)) {
      if (state.graph === null) continue
      if (suspension.version !== state.graph.version) continue // a stale plan's suspension never applies
      const nodeState = state.nodeStates.get(suspension.nodeId)
      if (nodeState === undefined || nodeState.status !== 'running') continue
      nodeState.status = 'suspended'
      nodeState.suspendedAt = Date.now()
      nodeState.endedAt = Date.now()
      if (state.running === suspension.nodeId) state.running = null
    }
  }

  /**
   * Release one node's running slot while keeping its one-shot approval.
   * @param {object} state
   * @param {string} id
   * @param {string} reason
   * @returns {boolean}
   */
  function suspendNode(state, id, reason) {
    const nodeState = state.nodeStates.get(id)
    if (nodeState === undefined) return false
    nodeState.status = 'suspended'
    nodeState.suspendedAt = Date.now()
    nodeState.endedAt = Date.now()
    nodeState.suspendReason = reason
    if (state.running === id) state.running = null
    clearIdle(state)
    return true
  }

  function pushAudit(nodeState, entry) {
    nodeState.audit.push(entry)
    if (nodeState.audit.length > MAX_AUDIT) nodeState.audit.splice(0, nodeState.audit.length - MAX_AUDIT)
  }

  /**
   * Rebuild graph, approvals, node windows and audit from the durable log.
   * @param {object} agent
   */
  function hydrate(agent) {
    const state = ensure(agent.id)
    if (state.hydrated) return state
    state.hydrated = true
    let events = []
    try {
      const session = agent.session
      if (session !== undefined && typeof session.snapshotEvents === 'function') events = session.snapshotEvents() ?? []
    } catch (error) {
      log('warn', `读取会话日志失败，预检状态从头开始：${message(error)}`)
      return state
    }
    try {
      const pendingAudit = new Map()
      for (const event of events) {
        if (event === null || typeof event !== 'object') continue
        const at = event.time ?? Date.now()
        if (event.type === 'tool/call') {
          const name = event.data?.name
          const callId = event.data?.callId
          let args = {}
          try {
            args = JSON.parse(event.data?.arguments ?? '{}')
          } catch {
            args = {}
          }
          if (name === 'preflight_graph') {
            const normalized = normalizeGraph(args, config.maxNodes)
            if (normalized.ok) {
              state.graph = { ...normalized.graph, version: (state.graph?.version ?? 0) + 1 }
              resetNodeStates(state, state.graph)
              state.running = null
            }
          } else if (name === 'preflight_graph_append' && state.graph !== null) {
            const appended = normalizeAppend(state.graph, args.nodes, config.maxNodes)
            if (appended.ok) {
              state.graph.nodes.push(...appended.nodes)
              appendNodeStates(state, appended.nodes)
            }
          } else if (name === 'preflight_node_start' && state.graph !== null) {
            const id = typeof args.id === 'string' ? args.id : ''
            const nodeState = state.nodeStates.get(id)
            if (nodeState !== undefined && (nodeState.status === 'approved' || nodeState.status === 'suspended')) {
              nodeState.status = 'running'
              if (nodeState.startedAt === 0) nodeState.startedAt = at
              nodeState.suspendReason = ''
              state.running = id
            }
          } else if (name === 'preflight_node_end' && state.graph !== null) {
            const id = typeof args.id === 'string' ? args.id : ''
            const nodeState = state.nodeStates.get(id)
            if (nodeState !== undefined && nodeState.status === 'running') {
              nodeState.status = args.success === false ? 'approved' : 'done'
              nodeState.endedAt = at
              if (state.running === id) state.running = null
            }
          } else if (state.running !== null && typeof name === 'string' && name.startsWith('preflight_') === false) {
            const nodeState = state.nodeStates.get(state.running)
            if (nodeState !== undefined) {
              const entry = { tool: name, summary: summarizeCall(name, args), outcome: 'pending', at, callId: callId === undefined ? '' : String(callId) }
              pushAudit(nodeState, entry)
              if (callId !== undefined) pendingAudit.set(String(callId), entry)
            }
          }
        } else if (event.type === 'tool/result') {
          const callId = event.data?.message?.toolCallId
          const entry = callId === undefined ? undefined : pendingAudit.get(String(callId))
          if (entry !== undefined) entry.outcome = event.data?.error === undefined ? 'ok' : 'error'
        } else if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
          // applied in event order: a node can only start after its approval landed
          for (const inserted of event.data.inserted) {
            const text = textOf(inserted)
            applyApprovals(state, text, at)
            applySuspensions(state, text)
          }
        } else if (event.type === 'user/message') {
          const text = textOf(event.data)
          applyApprovals(state, text, at)
          applySuspensions(state, text)
        }
      }
    } catch (error) {
      log('warn', `重建预检状态失败，按未批准处理：${message(error)}`)
      for (const nodeState of state.nodeStates.values()) {
        if (nodeState.status === 'approved' || nodeState.status === 'running') nodeState.status = 'proposed'
      }
      state.running = null
    }
    return state
  }

  /** Deliver guidance into the next step without waking an idle agent. */
  function guide(agent, text) {
    try {
      agent.inject(createUserMessage(text))
    } catch (error) {
      log('warn', `注入提示失败：${message(error)}`)
    }
  }

  /** Deliver a notice as a follow-up turn that wakes the agent. */
  function wake(agent, text) {
    try {
      if (config.wakeOnGrant && typeof agent.followup === 'function') agent.followup(createUserMessage(text))
      else guide(agent, text)
    } catch (error) {
      log('warn', `唤醒模型失败：${message(error)}`)
    }
  }

  /** Remember a dispatched call so approvals can be classified by arguments. */
  function rememberCall(exec) {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null || typeof agent.id !== 'string') return
      const callId = exec.callId
      if (callId === undefined || callId === null) return
      const state = ensure(agent.id)
      state.calls.set(String(callId), { name: exec.name, args: exec.arguments, at: Date.now() })
      if (state.calls.size > MAX_CALLS) {
        const oldest = state.calls.keys().next()
        if (!oldest.done) state.calls.delete(oldest.value)
      }
    } catch (error) {
      log('warn', `记录工具调用失败：${message(error)}`)
    }
  }

  /** Append one audit entry while a node is running. */
  function auditCall(exec) {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null || typeof agent.id !== 'string') return
      const state = ensure(agent.id)
      if (state.running === null) return
      const nodeState = state.nodeStates.get(state.running)
      if (nodeState === undefined) return
      const name = exec.name
      if (typeof name !== 'string' || name.startsWith('preflight_')) return
      pushAudit(nodeState, {
        tool: name,
        summary: summarizeCall(name, exec.arguments),
        outcome: 'pending',
        at: Date.now(),
        callId: exec.callId === undefined ? '' : String(exec.callId)
      })
    } catch (error) {
      log('warn', `记录审计失败：${message(error)}`)
    }
  }

  /** Settle the audit outcome of one finished call. */
  function noteResult(exec, result) {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null || typeof agent.id !== 'string') return
      const state = ensure(agent.id)
      const callId = exec.callId === undefined ? '' : String(exec.callId)
      if (callId.length === 0) return
      const failed = result?.isError === true
      for (const nodeState of state.nodeStates.values()) {
        for (let index = nodeState.audit.length - 1; index >= 0; index -= 1) {
          const entry = nodeState.audit[index]
          if (entry.callId === callId && entry.outcome === 'pending') {
            entry.outcome = failed ? 'error' : 'ok'
            return
          }
        }
      }
    } catch (error) {
      log('warn', `更新审计结果失败：${message(error)}`)
    }
  }

  /**
   * The `approval/request` waterfall listener body.
   *
   * A request is answered only when an approved node is running and the call's
   * impact kind is inside that node's declaration. Everything else is delegated,
   * with a timeout hand-off when the call is classifiable at all.
   */
  async function decideApproval(request, next) {
    try {
      const agent = request?.agent
      if (agent === undefined || agent === null || typeof agent.id !== 'string') return next()
      const state = hydrate(agent)
      if (state.running === null || state.graph === null) return next()
      const node = state.graph.nodes.find((candidate) => candidate.id === state.running)
      const nodeState = state.nodeStates.get(state.running)
      if (node === undefined || nodeState === undefined || nodeState.status !== 'running') return next()
      const record = request.callId === undefined ? undefined : state.calls.get(String(request.callId))
      const impact = impactOfCall(request.toolName, record?.args)
      if (impact !== null && node.impacts.includes(impact)) {
        const escalated = needsEscalation(record?.args)
        if (!escalated || node.escalate) {
          log('info', `节点 ${node.id} 放行 ${request.toolName}（影响 ${impact}）`)
          return 'allowed-once'
        }
      }
      const timeoutMs = config.approvalTimeoutSeconds * 1000
      if (impact === null || !(timeoutMs > 0)) return next()
      return await raceAnswer({ agent, request, next, state, node, nodeState, impact, timeoutMs })
    } catch (error) {
      log('warn', `审批拦截失败，交回原生审批：${message(error)}`)
      try {
        return next()
      } catch {
        return 'unavailable'
      }
    }
  }

  /**
   * Who can move while `id` is suspended?
   *
   * `ready`    — approved and dependency-clear: the model can start one right now.
   * `proposed` — independent, but still waiting for the user's approval.
   * `waiting`  — needs `id` directly or transitively, so it cannot move yet.
   * @param {object} state
   * @param {string} id
   * @returns {{ready: string[], proposed: string[], waiting: string[]}}
   */
  function switchInfo(state, id) {
    const graph = state.graph
    const ready = []
    const proposed = []
    const waiting = []
    if (graph === null) return { ready, proposed, waiting }
    for (const node of graph.nodes) {
      if (node.id === id) continue
      const nodeState = state.nodeStates.get(node.id)
      if (nodeState === undefined) continue
      if (nodeState.status === 'done' || nodeState.status === 'rejected' || nodeState.status === 'revoked') continue
      if (dependencyClosure(graph, node.id).has(id)) {
        waiting.push(node.id)
        continue
      }
      if (!node.dependsOn.every((dep) => state.nodeStates.get(dep)?.status === 'done')) continue
      if (nodeState.status === 'approved') ready.push(node.id)
      else if (nodeState.status === 'proposed') proposed.push(node.id)
    }
    return { ready, proposed, waiting }
  }

  function titleMap(state) {
    const titles = new Map()
    for (const node of state.graph?.nodes ?? []) titles.set(node.id, node.title)
    return titles
  }

  function labelIds(ids, titles) {
    return ids.map((id) => `${id}「${titles.get(id) ?? ''}」`).join('、')
  }

  /**
   * The message the model reads after its ad-hoc operation timed out: what was
   * suspended, which independent branch it can run now, and the marker that makes
   * the suspension replayable.
   * @returns {string}
   */
  function buildSuspendNotice({ state, node, toolName, impact, seconds }) {
    const titles = titleMap(state)
    const { ready, proposed, waiting } = switchInfo(state, node.id)
    const lines = [
      `⏸ 审批等待超时（${seconds} 秒）：刚才的「${toolName}」（影响 ${impact}）不在节点 ${node.id}「${node.title}」的申报范围内，该调用已快速失败，原生审批卡已撤回。`,
      `已自动挂起 ${node.id}：批准保留、执行槽位已释放，之后可以用 preflight_node_start ${node.id} 继续。`
    ]
    if (ready.length > 0) {
      lines.push(`与 ${node.id} 无依赖关系、现在就能做：${labelIds(ready, titles)}。下一步：preflight_node_start ${ready[0]}；不要重试刚才那个调用。`)
    } else if (proposed.length > 0) {
      lines.push(`现在没有已批准的独立节点；${labelIds(proposed, titles)} 仍在等用户批准——请用户在右侧面板批准，批准后你会被唤醒，再开始它。`)
    } else {
      lines.push(`剩余工作都依赖 ${node.id}，没有可切换的独立分支；等用户批准后再继续，不要重试。`)
    }
    if (waiting.length > 0) lines.push(`（${waiting.join('、')} 依赖 ${node.id}，必须等它完成。）`)
    lines.push('若确实需要这个操作：用 preflight_graph_append 追加一个节点写清它的本质并请用户批准；批准后先做它。')
    lines.push(suspendMarker(state.graph.version, node.id))
    return lines.join('\n')
  }

  function raceAnswer({ agent, request, next, state, node, nodeState, impact, timeoutMs }) {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        state.timers.delete(timer)
        if (settled) return
        settled = true
        const seconds = Math.max(1, Math.round(timeoutMs / 1000))
        pushAudit(nodeState, {
          tool: request.toolName,
          summary: `${request.toolName}（影响 ${impact}，超出节点 ${node.id} 的申报，已挂起等待批准）`,
          outcome: 'blocked',
          at: Date.now(),
          callId: request.callId === undefined ? '' : String(request.callId)
        })
        suspendNode(state, node.id, `等待「${request.toolName}」审批超时 ${seconds} 秒`)
        guide(agent, buildSuspendNotice({ state, node, toolName: request.toolName, impact, seconds }))
        log('info', `节点 ${node.id} 未覆盖 ${request.toolName}，超时挂起并交出独立分支`)
        resolve('rejected')
      }, timeoutMs)
      state.timers.add(timer)

      Promise.resolve()
        .then(next)
        .then(
          (outcome) => {
            state.timers.delete(timer)
            clearTimeout(timer)
            if (!settled) {
              settled = true
              resolve(outcome)
            }
          },
          () => {
            state.timers.delete(timer)
            clearTimeout(timer)
            if (!settled) {
              settled = true
              resolve('unavailable')
            }
          }
        )
    })
  }

  /** Replace the whole graph (invalidates every approval). */
  function setGraph(agent, raw) {
    const normalized = normalizeGraph(raw, config.maxNodes)
    if (!normalized.ok) return { ok: false, errors: normalized.errors }
    const state = hydrate(agent)
    clearIdle(state)
    state.graph = { ...normalized.graph, version: (state.graph?.version ?? 0) + 1 }
    resetNodeStates(state, state.graph)
    state.running = null
    log('info', `计算图已登记：v${state.graph.version}，${state.graph.nodes.length} 个节点`)
    return { ok: true, view: modelView(agent) }
  }

  /** Append nodes to the graph without touching existing approvals. */
  function appendGraph(agent, rawNodes) {
    const state = hydrate(agent)
    if (state.graph === null) return { ok: false, errors: ['当前没有计算图，请先调用 preflight_graph。'] }
    const appended = normalizeAppend(state.graph, rawNodes, config.maxNodes)
    if (!appended.ok) return { ok: false, errors: appended.errors }
    state.graph.nodes.push(...appended.nodes)
    appendNodeStates(state, appended.nodes)
    log('info', `计算图追加 ${appended.nodes.length} 个节点（v${state.graph.version}）`)
    return { ok: true, added: appended.nodes.map((node) => node.id), view: modelView(agent) }
  }

  /** Start one node: a fresh approval, or resume a suspended (approval kept). */
  function startNode(agent, id) {
    const state = hydrate(agent)
    if (state.graph === null) return { ok: false, reason: '当前没有计算图。' }
    const node = state.graph.nodes.find((candidate) => candidate.id === id)
    if (node === undefined) return { ok: false, reason: `未知节点：${id || '(空)'}` }
    const nodeState = state.nodeStates.get(id)
    if (nodeState === undefined) return { ok: false, reason: `节点 ${id} 状态缺失。` }
    if (state.running !== null) return { ok: false, reason: `节点 ${state.running} 正在执行，先结束它再开始下一个。` }
    if (nodeState.status === 'done') return { ok: false, reason: `节点 ${id} 已完成。` }
    if (nodeState.status === 'rejected' || nodeState.status === 'revoked') {
      return { ok: false, reason: `节点 ${id} 已被拒绝/撤销，请改计划或追加新节点。` }
    }
    if (nodeState.status !== 'approved' && nodeState.status !== 'suspended') {
      return { ok: false, reason: `节点 ${id} 还没有被批准。` }
    }
    const readiness = readinessOf(node, state.nodeStates)
    if (!readiness.ready) return { ok: false, reason: `节点 ${id} 还不能开始：${readiness.blockedBy}` }
    const resuming = nodeState.status === 'suspended'
    nodeState.status = 'running'
    if (nodeState.startedAt === 0) nodeState.startedAt = Date.now()
    if (resuming) {
      nodeState.resumeCount += 1
      nodeState.suspendReason = ''
    }
    state.running = id
    clearIdle(state)
    state.idleTimer = setTimeout(() => {
      try {
        if (nodeState.status !== 'running') return
        suspendNode(state, id, `空闲超时：执行超过 ${config.nodeIdleSeconds} 秒没有结束`)
        guide(
          agent,
          `⏸ 节点 ${id}「${node.title}」超过 ${config.nodeIdleSeconds} 秒没有结束，已自动挂起（不消耗批准）。` +
            `继续时用 preflight_node_start ${id}；也可以先做不依赖它的节点。 ${suspendMarker(state.graph.version, id)}`
        )
        log('warn', `节点 ${id} 空闲超时，自动挂起`)
      } catch {
        /* the timer must never throw */
      }
    }, config.nodeIdleSeconds * 1000)
    state.timers.add(state.idleTimer)
    return { ok: true, view: modelView(agent) }
  }

  /** Finish the running node; success consumes its approval, failure restores it. */
  function endNode(agent, id, success) {
    const state = hydrate(agent)
    if (state.graph === null) return { ok: false, reason: '当前没有计算图。' }
    if (state.running !== id) {
      const nodeState = state.nodeStates.get(id)
      if (nodeState?.status === 'suspended') {
        return { ok: false, reason: `节点 ${id} 当前是挂起状态（批准保留），要用 preflight_node_start ${id} 继续，而不是 end。` }
      }
      return { ok: false, reason: `节点 ${id} 当前不在执行（执行中：${state.running ?? '无'}）。` }
    }
    const nodeState = state.nodeStates.get(id)
    if (nodeState === undefined) return { ok: false, reason: `节点 ${id} 状态缺失。` }
    clearIdle(state)
    nodeState.status = success === false ? 'approved' : 'done'
    nodeState.endedAt = Date.now()
    state.running = null
    log('info', `节点 ${id} 结束：${success === false ? '失败（不消耗批准）' : '成功（批准已消耗）'}`)
    return { ok: true, view: modelView(agent) }
  }

  /** Approve nodes from a user action (panel). Never reachable from a tool. */
  function approveNodes(sessionId, ids) {
    const agent = agentOf(sessionId)
    if (agent === undefined) return { ok: false, reason: '该会话没有运行中的模型，无法批准。' }
    const state = hydrate(agent)
    if (state.graph === null) return { ok: false, reason: '当前没有计算图。' }
    const approved = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const node = state.graph.nodes.find((candidate) => candidate.id === id)
      const nodeState = state.nodeStates.get(id)
      if (node === undefined || nodeState === undefined || nodeState.status !== 'proposed') continue
      nodeState.status = 'approved'
      nodeState.approvedAt = Date.now()
      approved.push(node)
    }
    if (approved.length > 0) {
      const markers = approved.map((node) => approveMarker(state.graph.version, node.id)).join(' ')
      const list = approved.map((node) => `${node.id}「${node.title}」`).join('、')
      const suspended = [...state.nodeStates.entries()]
        .filter(([, nodeState]) => nodeState.status === 'suspended')
        .map(([id]) => id)
      const resumeHint = suspended.length > 0
        ? `已挂起的节点 ${suspended.join('、')} 保留着批准，可以用 preflight_node_start 继续。`
        : ''
      wake(agent, `${markers} 用户已批准计算图节点：${list}。这些节点是一次性授权：执行成功即消耗，失败不消耗、可重试。${resumeHint}`)
      log('info', `面板批准节点：${approved.map((node) => node.id).join(',')}（v${state.graph.version}）`)
    }
    return { ok: true, approved: approved.map((node) => node.id), view: panelView(sessionId) }
  }

  /** Reject nodes from a user action. */
  function rejectNodes(sessionId, ids) {
    const agent = agentOf(sessionId)
    const state = agent !== undefined ? hydrate(agent) : sessions.get(sessionId) ?? ensure(sessionId)
    const rejected = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const nodeState = state.nodeStates.get(id)
      if (nodeState === undefined || nodeState.status !== 'proposed') continue
      nodeState.status = 'rejected'
      rejected.push(id)
    }
    if (rejected.length > 0) log('info', `面板拒绝节点：${rejected.join(',')}`)
    return { ok: true, rejected, view: panelView(sessionId) }
  }

  /** Revoke approvals that have not been used yet. */
  function revokeNodes(sessionId, ids) {
    const agent = agentOf(sessionId)
    const state = agent !== undefined ? hydrate(agent) : sessions.get(sessionId) ?? ensure(sessionId)
    const revoked = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const nodeState = state.nodeStates.get(id)
      if (nodeState === undefined) continue
      if (nodeState.status !== 'approved' && nodeState.status !== 'suspended') continue
      nodeState.status = 'revoked'
      nodeState.suspendReason = ''
      revoked.push(id)
    }
    if (revoked.length > 0) log('info', `面板撤销节点：${revoked.join(',')}`)
    return { ok: true, revoked, view: panelView(sessionId) }
  }

  function readPolicy(agent) {
    try {
      const approval = ctx.approval
      if (agent !== undefined && approval !== undefined && typeof approval.overrideOf === 'function') {
        const policy = approval.overrideOf(agent.session)
        if (policy === 'ask' || policy === 'never') return policy
      }
    } catch {
      /* policy is informational only */
    }
    return 'default'
  }

  /** Snapshot for the panel (JSON-only, no live handles). */
  function panelView(sessionId) {
    const agent = agentOf(sessionId)
    const state = agent !== undefined ? hydrate(agent) : sessions.get(sessionId) ?? ensure(sessionId)
    const graph = state.graph
    const nodes = graph === null
      ? []
      : graph.nodes.map((node) => {
          const nodeState = state.nodeStates.get(node.id) ?? { status: 'proposed', audit: [] }
          const readiness = readinessOf(node, state.nodeStates)
          return {
            id: node.id,
            title: node.title,
            effect: node.effect,
            essence: { ...node.essence },
            note: node.note,
            dependsOn: [...node.dependsOn],
            dependents: dependentsOf(graph, node.id),
            impacts: [...node.impacts],
            escalate: node.escalate,
            permission: node.permission,
            status: nodeState.status,
            ready: readiness.ready,
            blockedBy: readiness.blockedBy,
            suspendReason: nodeState.suspendReason ?? '',
            resumeCount: nodeState.resumeCount ?? 0,
            audit: (nodeState.audit ?? []).slice(-15).map((entry) => ({ ...entry }))
          }
        })
    const count = (status) => nodes.filter((node) => node.status === status).length
    const switchable = nodes
      .filter((node) => node.ready && node.status !== 'suspended' && node.status !== 'running')
      .map((node) => node.id)
    return {
      sessionId,
      hasGraph: graph !== null,
      policy: readPolicy(agent),
      goal: graph?.goal ?? '',
      version: graph?.version ?? 0,
      running: state.running,
      suspended: nodes.filter((node) => node.status === 'suspended').map((node) => node.id),
      switchable,
      nodes,
      counts: {
        total: nodes.length,
        proposed: count('proposed'),
        approved: count('approved'),
        running: count('running'),
        suspended: count('suspended'),
        done: count('done'),
        rejected: count('rejected')
      },
      updatedAt: Date.now()
    }
  }

  /** Snapshot for tools (same data plus rendered text and a next action hint). */
  function modelView(agent) {
    const state = hydrate(agent)
    const graph = state.graph
    const nodes = graph === null
      ? []
      : graph.nodes.map((node) => {
          const nodeState = state.nodeStates.get(node.id) ?? { status: 'proposed' }
          const readiness = readinessOf(node, state.nodeStates)
          return {
            id: node.id,
            title: node.title,
            status: nodeState.status,
            impacts: [...node.impacts],
            escalate: node.escalate,
            ready: readiness.ready,
            blockedBy: readiness.blockedBy
          }
        })
    const pending = nodes.filter((node) => node.status === 'proposed').map((node) => node.id)
    const resumable = nodes.filter((node) => node.status === 'suspended' && node.ready).map((node) => node.id)
    const ready = nodes.filter((node) => node.status !== 'suspended' && node.ready).map((node) => node.id)
    const running = state.running
    const text = renderGraphText(graph, state.nodeStates, running)
    let instruction
    if (graph === null) {
      instruction = '还没有计算图。先调用 preflight_graph 登记：节点写清「这件事本质是什么」，并标注会碰外部世界的节点。'
    } else if (running !== null) {
      instruction = `节点 ${running} 正在执行。结束后调用 preflight_node_end；同一时刻只能有一个节点在执行。`
    } else if (resumable.length > 0 && ready.length > 0) {
      instruction =
        `节点 ${resumable.join('、')} 已挂起（批准保留，可用 preflight_node_start 继续）。` +
        `不依赖它的可执行节点：${ready.join('、')}——先做这些，再回来继续。`
    } else if (ready.length > 0) {
      instruction = resumable.length > 0
        ? `节点 ${resumable.join('、')} 已挂起（批准保留，可用 preflight_node_start 继续）。先做可执行节点：${ready.join('、')}，再回来继续。`
        : `可以开始这些节点：${ready.join('、')}。开始前调用 preflight_node_start。`
    } else if (resumable.length > 0) {
      instruction = `节点 ${resumable.join('、')} 已挂起（批准保留），用 preflight_node_start ${resumable[0]} 继续，不需要重新批准。`
    } else if (pending.length > 0) {
      instruction = `有 ${pending.length} 个节点等待用户批准：${pending.join('、')}。先做已批准且可执行的节点，不要空转；用户批准后会自动唤醒你。`
    } else if (nodes.every((node) => node.status === 'done')) {
      instruction = '所有节点都已完成。'
    } else {
      instruction = '当前没有可执行的节点：检查依赖是否完成，或追加新节点。'
    }
    return {
      hasGraph: graph !== null,
      goal: graph?.goal ?? '',
      version: graph?.version ?? 0,
      running: running ?? '',
      hasRunning: running !== null,
      pending,
      ready,
      resumable,
      nodes,
      text,
      instruction
    }
  }

  function dispose(sessionId) {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    clearIdle(state)
    for (const timer of state.timers) clearTimeout(timer)
    state.timers.clear()
    sessions.delete(sessionId)
  }

  function disposeAll() {
    for (const sessionId of [...sessions.keys()]) dispose(sessionId)
  }

  return {
    config,
    ensure,
    hydrate,
    rememberCall,
    auditCall,
    noteResult,
    decideApproval,
    setGraph,
    appendGraph,
    startNode,
    endNode,
    approveNodes,
    rejectNodes,
    revokeNodes,
    panelView,
    modelView,
    dispose,
    disposeAll
  }
}
