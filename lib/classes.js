/**
 * Coarse permission classes.
 *
 * The whole plugin trades precision for one-click usability: the user grants a
 * small closed vocabulary of permission classes instead of approving each call,
 * and every later approval request is matched against that vocabulary. A request
 * that cannot be classified positively is never auto-granted.
 */

/** Every class the ledger understands, in display order. */
export const GRANT_CLASSES = ['fs-write', 'exec', 'network', 'danger']

/** Human labels used by the panel and by model-facing text. */
export const CLASS_LABELS = {
  'fs-write': {
    zh: '写文件',
    en: 'Write files',
    hintZh: 'write / edit（可能包含工作区外路径）',
    hintEn: 'write / edit, possibly outside the workspace'
  },
  exec: {
    zh: '执行命令',
    en: 'Run commands',
    hintZh: 'pwsh / bash / terminal',
    hintEn: 'pwsh / bash / terminal'
  },
  network: {
    zh: '联网访问',
    en: 'Network access',
    hintZh: 'web_fetch / web_search',
    hintEn: 'web_fetch / web_search'
  },
  danger: {
    zh: '危险全权',
    en: 'Full access',
    hintZh: 'sandbox_permissions=danger-full-access，范围最大',
    hintEn: 'sandbox_permissions=danger-full-access, the widest scope'
  }
}

const WRITE_TOOLS = new Set(['write', 'edit'])
const EXEC_TOOLS = new Set(['pwsh', 'bash'])
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])

/**
 * Whether a string is a known permission class.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isGrantClass(value) {
  return typeof value === 'string' && GRANT_CLASSES.includes(value)
}

/**
 * Human label for a class.
 * @param {string} id
 * @returns {{zh: string, en: string, hintZh: string, hintEn: string}}
 */
export function labelOf(id) {
  return CLASS_LABELS[id] ?? { zh: id, en: id, hintZh: '', hintEn: '' }
}

/**
 * Classify one tool call into a permission class.
 *
 * Returns `null` when the call cannot be attributed positively; such requests
 * are always delegated to the user instead of being auto-granted. A tool name
 * that maps to a class is only half the story — the arguments decide whether the
 * call is a danger-full-access escalation, which outranks the tool's own class.
 *
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string | null}
 */
export function classifyRequest(toolName, args) {
  const name = typeof toolName === 'string' ? toolName : ''
  // The plugin's own tools never need the user's approval.
  if (name.startsWith('preflight_')) return null
  const sandbox = args !== null && typeof args === 'object' ? args.sandbox_permissions : undefined
  if (sandbox === 'danger-full-access') return 'danger'
  if (NETWORK_TOOLS.has(name)) return 'network'
  if (WRITE_TOOLS.has(name)) return 'fs-write'
  if (EXEC_TOOLS.has(name) || name.startsWith('terminal_')) return 'exec'
  return null
}
