/**
 * Effects, impacts, and how one tool call is classified.
 *
 * The authorization unit is a graph node whose declared "essence" the user
 * approves. A node also declares which impact kinds its execution may produce;
 * the approval interceptor only checks those kinds, never the command text.
 */

/** Node effects shown in the panel. */
export const EFFECTS = ['read', 'compute', 'download', 'write', 'delete', 'execute', 'network']

/** Impact kinds the interceptor understands. */
export const IMPACTS = ['fs-write', 'fs-delete', 'exec', 'network']

/** Default impacts per effect (used when a node omits `impacts`). */
export const DEFAULT_IMPACTS = {
  read: [],
  compute: [],
  download: ['network', 'fs-write'],
  write: ['fs-write'],
  delete: ['fs-delete'],
  execute: ['exec', 'fs-write'],
  network: ['network']
}

/** Effects that never need user approval. */
const OPEN_EFFECTS = new Set(['read', 'compute'])

export const EFFECT_LABELS = {
  read: '只读',
  compute: '计算',
  download: '下载',
  write: '写入',
  delete: '删除',
  execute: '执行',
  network: '联网'
}

export const IMPACT_LABELS = {
  'fs-write': '写文件',
  'fs-delete': '删除文件',
  exec: '执行命令',
  network: '网络'
}

const WRITE_TOOLS = new Set(['write', 'edit'])
const EXEC_TOOLS = new Set(['pwsh', 'bash'])
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])

/**
 * Whether a value is a known effect.
 * @param {unknown} value
 */
export function isEffect(value) {
  return typeof value === 'string' && EFFECTS.includes(value)
}

/**
 * Whether a value is a known impact kind.
 * @param {unknown} value
 */
export function isImpact(value) {
  return typeof value === 'string' && IMPACTS.includes(value)
}

/**
 * Default impacts for an effect.
 * @param {string} effect
 * @returns {string[]}
 */
export function defaultImpacts(effect) {
  return [...(DEFAULT_IMPACTS[effect] ?? [])]
}

/**
 * Whether an effect needs approval at all.
 * @param {string} effect
 * @returns {'required' | 'none'}
 */
export function defaultPermission(effect) {
  return OPEN_EFFECTS.has(effect) ? 'none' : 'required'
}

/**
 * Map an actual tool call onto one impact kind, or `null` when the call cannot be
 * attributed (third-party/MCP tools, interactive terminals).
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string | null}
 */
export function impactOfCall(toolName, args) {
  const name = typeof toolName === 'string' ? toolName : ''
  if (name.startsWith('preflight_')) return null
  if (WRITE_TOOLS.has(name)) return 'fs-write'
  if (EXEC_TOOLS.has(name)) return 'exec'
  if (NETWORK_TOOLS.has(name)) return 'network'
  return null
}

/**
 * Whether the call asks for a sandbox escalation.
 * @param {unknown} args
 */
export function needsEscalation(args) {
  return args !== null && typeof args === 'object' && args.sandbox_permissions === 'danger-full-access'
}

/**
 * One-line summary of a call, for the audit trail (never used for matching).
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string}
 */
export function summarizeCall(toolName, args) {
  const name = typeof toolName === 'string' ? toolName : 'tool'
  const source = args !== null && typeof args === 'object' ? args : {}
  const pick = (...keys) => {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return ''
  }
  let detail = ''
  if (WRITE_TOOLS.has(name)) detail = pick('path', 'file_path')
  else if (EXEC_TOOLS.has(name)) detail = pick('command', 'cmd')
  else if (name === 'web_fetch') detail = pick('url')
  else if (name === 'web_search') detail = pick('query')
  else if (name === 'read') detail = pick('path', 'file_path')
  else if (name === 'grep' || name === 'glob') detail = pick('pattern')
  else detail = pick('path', 'url', 'command', 'query')
  const text = detail.length > 0 ? `${name} ${detail}` : name
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}
