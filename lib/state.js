/**
 * Per-session preflight state: plan table, granted permission classes, approvals
 * that timed out (`pending`), and the call-id correlation map used to classify an
 * approval request.
 *
 * Two invariants shape this module:
 *  - The session log is the source of truth. The plan is recoverable from the
 *    `tool/call` events of preflight_plan / preflight_task, and grants are logged
 *    as injected user messages, so a resumed session rehydrates without its own
 *    database.
 *  - Nothing here may throw into a tool call or the approval waterfall. Every
 *    entry point degrades to "let the user decide" instead.
 */

import { GRANT_CLASSES, classifyRequest, isGrantClass, labelOf } from './classes.js'
import { classesFromGrantText, createUserMessage, grantMarker, textOf } from './messages.js'
import { applyTaskPatch, normalizePlan, readinessOf, renderPlanText, requiredClassesOf } from './plan.js'

const MAX_CALLS = 256
const MAX_SESSIONS = 64

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

  function ensure(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        id: sessionId,
        plan: null,
        grants: new Map(),
        pending: new Map(),
        calls: new Map(),
        timers: new Set(),
        hydrated: false,
        lastSeen: Date.now()
      }
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

  /**
   * Rebuild plan and grants from the durable session log, once per session.
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
      // A grant notice can be recorded in two shapes: as an inbox splice while it
      // is still pending, and as a consumed `user/message` once the turn took it.
      // Both are scanned so a grant survives whichever boundary the log replay
      // stops at.
      const harvest = (candidate, at) => {
        for (const id of classesFromGrantText(textOf(candidate))) {
          if (isGrantClass(id)) state.grants.set(id, { at, source: 'log' })
        }
      }
      for (const event of events) {
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'tool/call') {
          const name = event.data?.name
          const raw = event.data?.arguments
          if (name === 'preflight_plan') {
            try {
              const parsed = normalizePlan(JSON.parse(raw), config.maxTasks)
              if (parsed.ok) state.plan = parsed.plan
            } catch {
              /* a malformed historical call is ignored */
            }
          } else if (name === 'preflight_task' && state.plan !== null) {
            try {
              applyTaskPatch(state.plan, JSON.parse(raw))
            } catch {
              /* ignore */
            }
          }
        } else if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
          for (const inserted of event.data.inserted) harvest(inserted, event.time ?? Date.now())
        } else if (event.type === 'user/message') {
          harvest(event.data, event.time ?? Date.now())
        }
      }
    } catch (error) {
      log('warn', `重建预检状态失败：${message(error)}`)
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

  /** Deliver a grant notice as a follow-up turn that wakes the agent. */
  function wake(agent, text) {
    try {
      if (config.wakeOnGrant && typeof agent.followup === 'function') agent.followup(createUserMessage(text))
      else guide(agent, text)
    } catch (error) {
      log('warn', `唤醒模型失败：${message(error)}`)
    }
  }

  /**
   * Remember a dispatched call so an approval request can be classified by its
   * arguments. Approval requests carry `callId`; the arguments live here.
   */
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

  /** Resolve a class for one approval request, or `null` when unattributable. */
  function classOf(request, state) {
    const callId = request?.callId
    if (callId !== undefined && callId !== null) {
      const recorded = state.calls.get(String(callId))
      if (recorded !== undefined) return classifyRequest(recorded.name ?? request.toolName, recorded.args)
    }
    return classifyRequest(request?.toolName, undefined)
  }

  /**
   * The `approval/request` waterfall listener body.
   *
   * Order of decisions:
   *  1. a granted class answers `allowed-once` immediately — the user never sees it;
   *  2. an ungranted but preflight-eligible class is raced against the configured
   *     timeout: the real answerer still runs, so a late click becomes a grant;
   *  3. everything else is delegated untouched.
   */
  async function decideApproval(request, next) {
    try {
      const agent = request?.agent
      if (agent === undefined || agent === null || typeof agent.id !== 'string') return next()
      const toolName = typeof request.toolName === 'string' ? request.toolName : ''
      if (toolName.startsWith('preflight_')) return next()
      const state = hydrate(agent)
      const permissionClass = classOf(request, state)
      const eligible = permissionClass !== null && config.enabledClasses.includes(permissionClass)

      if (eligible && state.grants.has(permissionClass)) {
        state.pending.delete(permissionClass)
        log('info', `已按预授权放行 ${permissionClass}（${toolName}）`)
        return 'allowed-once'
      }

      const timeoutMs = config.approvalTimeoutSeconds * 1000
      if (!eligible || !(timeoutMs > 0)) return next()

      return await raceAnswer({ agent, request, next, state, permissionClass, timeoutMs, toolName })
    } catch (error) {
      log('warn', `审批拦截失败，交回原生审批：${message(error)}`)
      try {
        return next()
      } catch {
        return 'unavailable'
      }
    }
  }

  function raceAnswer({ agent, request, next, state, permissionClass, timeoutMs, toolName }) {
    const label = labelOf(permissionClass)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        state.timers.delete(timer)
        if (settled) return
        settled = true
        state.pending.set(permissionClass, {
          class: permissionClass,
          toolName,
          callId: request.callId,
          at: Date.now()
        })
        const seconds = Math.round(timeoutMs / 1000)
        guide(
          agent,
          `⏸ 审批等待超时（${seconds} 秒）：${label.zh}。该请求已挂起为「待授权」，用户在右侧预检面板或原生审批卡上授权后会自动通知你。` +
            '请先继续执行不需要该权限的子任务（可用 preflight_status 查看哪些还剩）；' +
            '如果全部子任务都被它挡住，直接结束本轮，不要反复重试同一个调用。'
        )
        log('info', `审批超时让路 ${permissionClass}（${toolName}）`)
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
              return
            }
            // The user answered the native card after the timeout: that click is
            // still a decision, so promote it into a standing grant.
            if (outcome === 'allowed-once') {
              state.grants.set(permissionClass, { at: Date.now(), source: 'late-approval' })
              state.pending.delete(permissionClass)
              wake(
                agent,
                `${grantMarker([permissionClass])} 用户刚才在审批卡上点了允许：${label.zh} 之后自动放行。` +
                  '可以重试之前被挡住的调用，或继续推进相关子任务。'
              )
              log('info', `迟到审批转为预授权 ${permissionClass}`)
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

  /** Replace (or clear) the plan table; called by the preflight_plan tool. */
  function setPlan(agent, raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const state = hydrate(agent)
    // An explicit empty task list retires the table — the work is done, or the
    // user started a different request. Without it the panel would keep showing
    // a stale plan forever.
    if (Array.isArray(source.tasks) && source.tasks.length === 0) {
      state.plan = null
      state.pending.clear()
      return { ok: true, cleared: true, view: modelView(agent) }
    }
    const normalized = normalizePlan(raw, config.maxTasks)
    if (!normalized.ok) return { ok: false, errors: normalized.errors }
    state.plan = normalized.plan
    return { ok: true, cleared: false, view: modelView(agent) }
  }

  /** Patch one task; called by the preflight_task tool. */
  function setTask(agent, patch) {
    const state = hydrate(agent)
    const result = applyTaskPatch(state.plan, patch)
    if (!result.ok) return { ok: false, reason: result.reason }
    return { ok: true, view: modelView(agent) }
  }

  /** Snapshot for the panel (JSON-only, no live handles). */
  function panelView(sessionId) {
    const agent = agentOf(sessionId)
    const state = agent !== undefined ? hydrate(agent) : sessions.get(sessionId) ?? ensure(sessionId)
    const plan = state.plan
    const granted = new Set(state.grants.keys())
    const required = requiredClassesOf(plan, config.enabledClasses)
    const readiness = readinessOf(plan, granted)
    const grantedPolicy = readPolicy(agent)

    const tasks = plan === null
      ? []
      : plan.tasks.map((task) => {
          const info = readiness.get(task.id) ?? { ready: false, missingDeps: [], missingGrants: [] }
          return {
            id: task.id,
            title: task.title,
            state: task.state,
            needs: [...task.needs],
            dependsOn: [...task.dependsOn],
            note: task.note ?? '',
            ready: info.ready,
            missingDeps: [...info.missingDeps],
            missingGrants: [...info.missingGrants]
          }
        })

    const classes = GRANT_CLASSES.filter((id) => config.enabledClasses.includes(id)).map((id) => {
      const grant = state.grants.get(id)
      const pending = state.pending.get(id)
      return {
        id,
        label: labelOf(id),
        required: required.includes(id),
        granted: grant !== undefined,
        grantedAt: grant?.at ?? 0,
        pending: pending !== undefined,
        pendingAt: pending?.at ?? 0,
        pendingTool: pending?.toolName ?? ''
      }
    })

    return {
      sessionId,
      hasAgent: agent !== undefined,
      policy: grantedPolicy,
      goal: plan?.goal ?? '',
      note: plan?.note ?? '',
      planAt: plan?.at ?? 0,
      tasks,
      classes,
      counts: {
        tasks: tasks.length,
        done: tasks.filter((task) => task.state === 'done').length,
        ready: tasks.filter((task) => task.ready).length,
        missing: required.filter((id) => !granted.has(id)).length,
        pending: state.pending.size
      },
      updatedAt: Date.now()
    }
  }

  /** Snapshot for tools (same data, plus a rendered table). */
  function modelView(agent) {
    const state = hydrate(agent)
    const granted = new Set(state.grants.keys())
    const readiness = readinessOf(state.plan, granted)
    const required = requiredClassesOf(state.plan, config.enabledClasses)
    const missing = required.filter((id) => !granted.has(id))
    const readyNow = state.plan === null
      ? []
      : state.plan.tasks.filter((task) => readiness.get(task.id)?.ready === true).map((task) => task.id)
    return {
      hasPlan: state.plan !== null,
      goal: state.plan?.goal ?? '',
      required,
      granted: GRANT_CLASSES.filter((id) => granted.has(id)),
      missing,
      pending: [...state.pending.keys()],
      readyNow,
      blocked: state.plan === null
        ? []
        : state.plan.tasks
            .filter((task) => task.state === 'pending' && readiness.get(task.id)?.ready !== true)
            .map((task) => ({ id: task.id, missing: readiness.get(task.id)?.missingGrants ?? [] })),
      text: renderPlanText(state.plan, granted, readiness, state.pending.keys())
    }
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

  /** Grant classes from a user action (panel). User-only; never model-reachable. */
  function grant(sessionId, classes, source = 'panel') {
    const agent = agentOf(sessionId)
    if (agent === undefined) return { ok: false, reason: '该会话没有运行中的模型，无法登记授权。' }
    const state = hydrate(agent)
    const accepted = []
    const ignored = []
    for (const entry of Array.isArray(classes) ? classes : []) {
      if (!isGrantClass(entry) || !config.enabledClasses.includes(entry)) {
        ignored.push(entry)
        continue
      }
      state.grants.set(entry, { at: Date.now(), source })
      state.pending.delete(entry)
      if (!accepted.includes(entry)) accepted.push(entry)
    }
    if (accepted.length > 0) {
      const labels = accepted.map((id) => labelOf(id).zh).join('、')
      wake(agent, `${grantMarker(accepted)} 用户已在预检面板授权：${labels}。这些类别之后直接放行，不再逐次询问。可以继续被它挡住的子任务，或重试之前失败的调用。`)
      log('info', `面板授权 ${accepted.join(',')}（会话 ${sessionId}）`)
    }
    return { ok: true, accepted, ignored, view: panelView(sessionId) }
  }

  /** Revoke classes from a user action (panel). */
  function revoke(sessionId, classes) {
    const state = sessions.get(sessionId) ?? ensure(sessionId)
    const agent = agentOf(sessionId)
    if (agent !== undefined) hydrate(agent)
    const removed = []
    for (const entry of Array.isArray(classes) ? classes : []) {
      if (state.grants.delete(entry)) removed.push(entry)
    }
    if (removed.length > 0) log('info', `撤销授权 ${removed.join(',')}（会话 ${sessionId}）`)
    return { ok: true, removed, view: panelView(sessionId) }
  }

  function dispose(sessionId) {
    const state = sessions.get(sessionId)
    if (state === undefined) return
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
    decideApproval,
    setPlan,
    setTask,
    panelView,
    modelView,
    grant,
    revoke,
    dispose,
    disposeAll
  }
}
