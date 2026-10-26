/**
 * The plan table: task decomposition plus the permission classes each task is
 * expected to need.
 *
 * The table is intentionally small and JSON-only so it can be passed as tool
 * arguments; that makes it recoverable from the session log after a resume
 * without a second persistence layer.
 */

import { GRANT_CLASSES, isGrantClass, labelOf } from './classes.js'

/** Allowed task states. */
export const TASK_STATES = ['pending', 'running', 'done', 'blocked']

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/
const MAX_TITLE = 160
const MAX_GOAL = 400
const MAX_NOTE = 500

/**
 * Validate and normalize one raw plan from tool arguments.
 * @param {unknown} raw
 * @param {number} maxTasks
 * @returns {{ok: boolean, errors: string[], plan: {goal: string, note: string, tasks: Array<{id: string, title: string, needs: string[], dependsOn: string[], state: string, note: string, updatedAt: number}>, at: number}}}
 */
export function normalizePlan(raw, maxTasks) {
  const errors = []
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const goal = typeof source.goal === 'string' ? source.goal.trim().slice(0, MAX_GOAL) : ''
  if (!goal) errors.push('goal 不能为空')

  const rawTasks = Array.isArray(source.tasks) ? source.tasks : []
  if (rawTasks.length === 0) errors.push('tasks 至少要有 1 项')
  if (rawTasks.length > maxTasks) errors.push(`tasks 最多 ${maxTasks} 项`)

  const tasks = []
  const seen = new Set()
  const limit = Math.min(rawTasks.length, maxTasks)
  for (let index = 0; index < limit; index += 1) {
    const entry = rawTasks[index] !== null && typeof rawTasks[index] === 'object' ? rawTasks[index] : {}
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!ID_PATTERN.test(id)) {
      errors.push(`第 ${index + 1} 项的 id 非法（需 1-16 位字母数字/-/_）：${id || '(空)'}`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`id 重复：${id}`)
      continue
    }
    seen.add(id)
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, MAX_TITLE) : ''
    if (!title) errors.push(`${id} 缺少 title`)
    const needs = []
    if (Array.isArray(entry.needs)) {
      for (const need of entry.needs) {
        if (isGrantClass(need) && !needs.includes(need)) needs.push(need)
      }
    }
    const dependsOn = []
    if (Array.isArray(entry.dependsOn)) {
      for (const dep of entry.dependsOn) {
        if (typeof dep === 'string' && !dependsOn.includes(dep)) dependsOn.push(dep)
      }
    }
    const state = TASK_STATES.includes(entry.status) ? entry.status : 'pending'
    tasks.push({ id, title, needs, dependsOn, state, note: '', updatedAt: Date.now() })
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep)) errors.push(`${task.id} 依赖了不存在的子任务：${dep}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    plan: {
      goal,
      note: typeof source.note === 'string' ? source.note.trim().slice(0, MAX_NOTE) : '',
      tasks,
      at: Date.now()
    }
  }
}

/**
 * Union of the permission classes the plan asks for, restricted to enabled ones.
 * @param {{tasks: Array<{needs: string[]}>} | null} plan
 * @param {string[]} enabledClasses
 * @returns {string[]}
 */
export function requiredClassesOf(plan, enabledClasses) {
  const required = new Set()
  if (plan && Array.isArray(plan.tasks)) {
    for (const task of plan.tasks) {
      for (const need of Array.isArray(task.needs) ? task.needs : []) {
        if (enabledClasses.includes(need)) required.add(need)
      }
    }
  }
  return GRANT_CLASSES.filter((id) => required.has(id))
}

/**
 * Per-task readiness: dependency-free, grant-covered, and still to do.
 * @param {{tasks: Array<{id: string, needs: string[], dependsOn: string[], state: string}>} | null} plan
 * @param {Set<string>} granted
 * @returns {Map<string, {ready: boolean, missingDeps: string[], missingGrants: string[]}>}
 */
export function readinessOf(plan, granted) {
  const readiness = new Map()
  if (!plan || !Array.isArray(plan.tasks)) return readiness
  const done = new Set(plan.tasks.filter((task) => task.state === 'done').map((task) => task.id))
  for (const task of plan.tasks) {
    const missingDeps = (Array.isArray(task.dependsOn) ? task.dependsOn : []).filter((dep) => !done.has(dep))
    const missingGrants = (Array.isArray(task.needs) ? task.needs : []).filter((need) => !granted.has(need))
    const ready = task.state === 'pending' && missingDeps.length === 0 && missingGrants.length === 0
    readiness.set(task.id, { ready, missingDeps, missingGrants })
  }
  return readiness
}

/**
 * Apply one status/note update from `preflight_task`.
 * @param {{tasks: Array<object>} | null} plan
 * @param {unknown} patch
 * @returns {{ok: boolean, reason?: string, task?: object}}
 */
export function applyTaskPatch(plan, patch) {
  const source = patch !== null && typeof patch === 'object' ? patch : {}
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!plan || !Array.isArray(plan.tasks)) return { ok: false, reason: '当前会话还没有计划表，请先调用 preflight_plan。' }
  const task = plan.tasks.find((candidate) => candidate.id === id)
  if (!task) return { ok: false, reason: `未知子任务：${id || '(空)'}。可用 id：${plan.tasks.map((t) => t.id).join(', ')}` }
  if (TASK_STATES.includes(source.status)) task.state = source.status
  if (typeof source.note === 'string') task.note = source.note.trim().slice(0, MAX_NOTE)
  task.updatedAt = Date.now()
  return { ok: true, task }
}

/**
 * Compact model-facing rendering of the plan table.
 * @param {{goal: string, note: string, tasks: Array<object>} | null} plan
 * @param {Set<string>} granted
 * @param {Map<string, {ready: boolean, missingDeps: string[], missingGrants: string[]}>} readiness
 * @param {Iterable<string>} pendingClasses
 * @returns {string}
 */
export function renderPlanText(plan, granted, readiness, pendingClasses) {
  if (!plan) return '当前会话还没有计划表。'
  const pending = new Set(pendingClasses)
  const lines = [`目标：${plan.goal}`]
  if (plan.note) lines.push(`备注：${plan.note}`)
  lines.push('子任务：')
  for (const task of plan.tasks) {
    const info = readiness.get(task.id) ?? { ready: false, missingDeps: [], missingGrants: [] }
    const marks = []
    if (task.state !== 'pending') marks.push(task.state)
    else if (info.ready) marks.push('可开工')
    else if (info.missingDeps.length > 0) marks.push(`等 ${info.missingDeps.join('/')}`)
    else marks.push('等授权')
    const needsText = task.needs.length > 0
      ? task.needs.map((need) => `${labelOf(need).zh}${granted.has(need) ? '✓' : pending.has(need) ? '(待批)' : ''}`).join('、')
      : '无需权限'
    lines.push(`- ${task.id} ${task.title} [${marks.join('，')}] 需要：${needsText}`)
  }
  return lines.join('\n')
}
