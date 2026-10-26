/**
 * The panel's JSON endpoint bodies.
 *
 * Transport-independent: the same handler is served either by the generic
 * Connection RPC channel or by the plugin's own prefix route, depending on what
 * the deployment makes reachable.
 *
 * Every user-visible mutation here is a user action (a panel click). The model
 * has no tool that reaches this endpoint.
 */

export const PROTOCOL_VERSION = 1

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
      if (endpoint === 'ping') return ok({ ok: true, protocol: PROTOCOL_VERSION })
      if (sessionId.length === 0) return fail('preflight/bad-request', 'sessionId 必填')

      switch (endpoint) {
        case 'status':
          return ok(state.panelView(sessionId))
        case 'grant': {
          const result = state.grant(sessionId, body.classes)
          if (result.ok !== true) return fail('preflight/no-agent', result.reason ?? '无法授权')
          return ok(result)
        }
        case 'revoke':
          return ok(state.revoke(sessionId, body.classes))
        default:
          return fail('preflight/unknown-endpoint', `未知端点：${String(endpoint)}`)
      }
    } catch (error) {
      return fail('preflight/failed', error instanceof Error ? error.message : String(error))
    }
  }
}
