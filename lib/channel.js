/**
 * Install the panel's JSON channel.
 *
 * Why not `connection.rpc.handle`: that helper registers the route on the
 * *connection service's own context* (`owner.webServer.register`), and that
 * context does not inject `webServer` — so from any third-party plugin it throws
 * `cannot get property "webServer" without inject`. The generic channel is only
 * usable by the plugin that owns the service.
 *
 * Instead this registers an owned prefix route on the Host web server and speaks
 * the same `client-request` / `server-response` envelope the browser's generic
 * RPC caller expects, reusing `connection.admit` for the same Host/Origin fence
 * and browser-credential check. Ownership is ours, so the route dies with this
 * plugin.
 */

import { hostLog } from './log.js'

/** The channel path the browser half calls. */
export const CHANNEL = '/dsh-approval-preflight'

function describe(error) {
  return error instanceof Error ? `${error.message}` : String(error)
}

function bodyOf(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function sendJson(response, status, value) {
  const text = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  })
  response.end(text)
}

/**
 * Register the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - a context that injected `connection` and `webServer`
 * @param {(endpoint: string, payload: unknown) => Promise<unknown>} handler
 * @returns {() => void} disposer
 */
export function installChannel(ctx, handler) {
  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (request, response) => {
      try {
        if (ctx.connection !== undefined && typeof ctx.connection.admit === 'function') {
          const admission = ctx.connection.admit(request)
          if (admission !== undefined && 'rejection' in admission) {
            response.writeHead(admission.rejection)
            response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
        }
        const raw = await bodyOf(request)
        let envelope
        try {
          envelope = JSON.parse(raw.toString('utf8'))
        } catch {
          response.writeHead(400)
          response.end('body is not JSON')
          return
        }
        if (
          envelope === null ||
          typeof envelope !== 'object' ||
          envelope.type !== 'client-request' ||
          typeof envelope.rpcId !== 'string' ||
          typeof envelope.method !== 'string'
        ) {
          response.writeHead(400)
          response.end('invalid client-request envelope')
          return
        }
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        const endpoint = pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : ''
        if (endpoint !== envelope.method) {
          sendJson(response, 200, {
            type: 'server-response',
            rpcId: envelope.rpcId,
            result: { ok: false, error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: {} } }
          })
          return
        }
        let result
        try {
          result = await handler(endpoint, envelope.payload)
        } catch (error) {
          hostLog(`channel handler threw: ${describe(error)}`)
          response.writeHead(500)
          response.end('handler failure')
          return
        }
        sendJson(response, 200, { type: 'server-response', rpcId: envelope.rpcId, result })
      } catch (error) {
        hostLog(`channel route failed: ${describe(error)}`)
        try {
          response.writeHead(500)
          response.end('channel failure')
        } catch {
          /* response may already be closed */
        }
      }
    }
  }

  const dispose = ctx.webServer.register(route)
  hostLog(`channel: prefix route installed on ${CHANNEL}`)
  return () => {
    try {
      dispose()
    } catch {
      /* disposal must not throw */
    }
  }
}
