/**
 * The panel's JSON endpoint bodies.
 *
 * Transport-independent: the same handler is served by the plugin's own prefix
 * route. Every mutation here is a user action; the model has no tool that reaches
 * this endpoint.
 */

import { PLUGIN_NAME, VERSION } from './version.js'

export const PROTOCOL_VERSION = 2

/** Identity every panel response carries, so the UI can show the loaded build. */
const PLUGIN_INFO = Object.freeze({ name: PLUGIN_NAME, version: VERSION, protocol: PROTOCOL_VERSION })

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Build the endpoint handler.
 * @param {ReturnType<import('./state.js').createState>} state
 * @returns {(endpoint: string, payload: unknown) => Promise<unknown>}
 */
export function createRpcHandler(state) {
  return async function handler(endpoint, payload) {
    try {
      const body = payload !== null && typeof payload === 'object' ? payload : {}
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (endpoint === 'ping') return ok({ ok: true, ...PLUGIN_INFO })
      if (sessionId.length === 0) return fail('preflight/bad-request', 'sessionId 必填')

      switch (endpoint) {
        case 'status':
          return ok({ ...state.panelView(sessionId), plugin: PLUGIN_INFO })
        case 'approve': {
          const result = state.approveNodes(sessionId, body.nodeIds)
          if (result.ok !== true) return fail('preflight/no-agent', result.reason ?? '无法批准')
          return ok(result)
        }
        case 'reject':
          return ok(state.rejectNodes(sessionId, body.nodeIds))
        case 'revoke':
          return ok(state.revokeNodes(sessionId, body.nodeIds))
        default:
          return fail('preflight/unknown-endpoint', `未知端点：${String(endpoint)}`)
      }
    } catch (error) {
      return fail('preflight/failed', error instanceof Error ? error.message : String(error))
    }
  }
}
