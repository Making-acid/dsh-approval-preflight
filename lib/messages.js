/**
 * Message construction and the durable approval marker.
 *
 * An approval is recorded as an injected user message carrying
 * `[[preflight:approve:<graphVersion>:<nodeId>]]`; the session log then replays
 * the approval without a second persistence layer.
 */

import { randomUUID } from 'node:crypto'

/** Marker prefix of one node approval. */
export const APPROVE_MARKER = '[[preflight:approve'

const APPROVE_PATTERN = /\[\[preflight:approve:(\d+):([A-Za-z0-9][A-Za-z0-9_-]{0,15})\]\]/g

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
 * Render the marker for one approval.
 * @param {number} version
 * @param {string} nodeId
 * @returns {string}
 */
export function approveMarker(version, nodeId) {
  return `[[preflight:approve:${version}:${nodeId}]]`
}

/**
 * Parse every approval marker in one text.
 * @param {string} text
 * @returns {Array<{version: number, nodeId: string}>}
 */
export function parseApprovals(text) {
  if (typeof text !== 'string' || !text.includes(APPROVE_MARKER)) return []
  const found = []
  APPROVE_PATTERN.lastIndex = 0
  let match = APPROVE_PATTERN.exec(text)
  while (match !== null) {
    found.push({ version: Number.parseInt(match[1], 10), nodeId: match[2] })
    match = APPROVE_PATTERN.exec(text)
  }
  return found
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
