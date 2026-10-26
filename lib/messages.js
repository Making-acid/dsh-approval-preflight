/**
 * Message construction without importing a Harness package.
 *
 * A profile-installed bundle resolves its own imports from the profile tree, so
 * the plugin must not depend on `@deepseek-ai/*` modules. Message identity is
 * trivially reproducible here: the frozen value shape is what the agent inbox
 * and the session log consume.
 */

import { randomUUID } from 'node:crypto'

/**
 * Marker prefix that makes a granted permission class recoverable from the log.
 * The canonical on-wire form is `[[preflight:grant:fs-write,exec]]`; the parser
 * also accepts the earlier `[[preflight:grant]]:fs-write,exec` form so a session
 * written by a previous build still rehydrates.
 */
export const GRANT_MARKER = '[[preflight:grant'

/**
 * Render the durable grant marker for a set of class ids.
 * @param {readonly string[]} ids
 * @returns {string}
 */
export function grantMarker(ids) {
  return `[[preflight:grant:${ids.join(',')}]]`
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build one user-role message carrying a single text block.
 * @param {string} text
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'user'}}}
 */
export function createUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  })
}

/**
 * Read the plain text of one message value, for log harvesting.
 * @param {unknown} message
 * @returns {string}
 */
export function textOf(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Parse granted class ids out of one harvested message.
 * @param {string} text
 * @returns {string[]}
 */
export function classesFromGrantText(text) {
  if (typeof text !== 'string' || !text.includes(GRANT_MARKER)) return []
  const canonical = text.match(/\[\[preflight:grant:([^\]]*)\]\]/)
  const legacy = text.match(/\[\[preflight:grant\]\]:([A-Za-z0-9_,.-]+)/)
  const raw = canonical?.[1] ?? legacy?.[1] ?? ''
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
