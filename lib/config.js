/**
 * Configuration normalization for the approval-preflight bundle.
 *
 * The Loader row's `config` is user-editable YAML, so every value is treated as
 * untrusted input and clamped to a safe range before the runtime sees it.
 */

import { GRANT_CLASSES } from './classes.js'

export const CONFIG_DEFAULTS = {
  approvalTimeoutSeconds: 90,
  enabledClasses: ['fs-write', 'exec', 'network', 'danger'],
  maxTasks: 40,
  wakeOnGrant: true
}

const MIN_TIMEOUT = 0
const MAX_TIMEOUT = 3600
const MIN_TASKS = 1
const MAX_TASKS = 200

function readNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function readBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(normalized)) return true
    if (['false', 'no', 'off', '0'].includes(normalized)) return false
  }
  return fallback
}

function readClasses(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const selected = []
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim() : ''
    if (GRANT_CLASSES.includes(name) && !selected.includes(name)) selected.push(name)
  }
  return selected.length > 0 ? selected : [...fallback]
}

/**
 * Normalize one Loader row config.
 * @param {unknown} raw
 * @returns {{approvalTimeoutSeconds: number, enabledClasses: string[], maxTasks: number, wakeOnGrant: boolean}}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    approvalTimeoutSeconds: readNumber(source.approvalTimeoutSeconds, CONFIG_DEFAULTS.approvalTimeoutSeconds, MIN_TIMEOUT, MAX_TIMEOUT),
    enabledClasses: readClasses(source.enabledClasses, CONFIG_DEFAULTS.enabledClasses),
    maxTasks: readNumber(source.maxTasks, CONFIG_DEFAULTS.maxTasks, MIN_TASKS, MAX_TASKS),
    wakeOnGrant: readBoolean(source.wakeOnGrant, CONFIG_DEFAULTS.wakeOnGrant)
  }
}
