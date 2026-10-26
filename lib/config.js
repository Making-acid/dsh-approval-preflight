/**
 * Configuration normalization for the approval-preflight bundle.
 *
 * The Loader row's `config` is user-editable YAML, so every value is clamped to a
 * safe range before the runtime sees it.
 */

export const CONFIG_DEFAULTS = {
  approvalTimeoutSeconds: 90,
  nodeIdleSeconds: 600,
  maxNodes: 80,
  wakeOnGrant: true
}

const MIN_TIMEOUT = 0
const MAX_TIMEOUT = 3600
const MIN_IDLE = 30
const MAX_IDLE = 7200
const MIN_NODES = 1
const MAX_NODES = 200

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

/**
 * Normalize one Loader row config.
 * @param {unknown} raw
 * @returns {{approvalTimeoutSeconds: number, nodeIdleSeconds: number, maxNodes: number, wakeOnGrant: boolean}}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    approvalTimeoutSeconds: readNumber(source.approvalTimeoutSeconds, CONFIG_DEFAULTS.approvalTimeoutSeconds, MIN_TIMEOUT, MAX_TIMEOUT),
    nodeIdleSeconds: readNumber(source.nodeIdleSeconds, CONFIG_DEFAULTS.nodeIdleSeconds, MIN_IDLE, MAX_IDLE),
    maxNodes: readNumber(source.maxNodes, CONFIG_DEFAULTS.maxNodes, MIN_NODES, MAX_NODES),
    wakeOnGrant: readBoolean(source.wakeOnGrant, CONFIG_DEFAULTS.wakeOnGrant)
  }
}
