/**
 * dsh-approval-preflight — graph-first permission preflight for DeepSeek Harness.
 *
 * The bundle contributes:
 *  - five model-facing tools: declare a computation graph, append nodes, start and
 *    end a node, read the graph;
 *  - an `approval/request` interpreter that answers a call only while an approved
 *    node is running and the call's impact kind is inside that node's declared
 *    impacts;
 *  - an audit trail of what actually ran inside each node;
 *  - a system-prompt section that teaches the graph-first workflow;
 *  - an authenticated JSON channel and the Client half that renders the panel.
 *
 * Nothing here widens the model's authority: approvals only come from a user
 * action, and an unclassifiable request is always delegated to the native card.
 */

import { CHANNEL, installChannel } from './lib/channel.js'
import { normalizeConfig } from './lib/config.js'
import { hostLog } from './lib/log.js'
import { createPromptSection } from './lib/prompt.js'
import { createRpcHandler } from './lib/rpc.js'
import { createState } from './lib/state.js'
import { createTools } from './lib/tools.js'
import { VERSION } from './lib/version.js'

/** Cordis plugin name (used by logs and diagnostics). */
export const name = 'approval-preflight'

/**
 * Hard dependencies. Cordis refuses property access to a service that is not
 * declared here (`cannot get property "x" without inject`), so every service the
 * plugin reads directly must be listed — including `agents` (to resolve a live
 * session) and `approval` (to read the session policy).
 */
export const inject = ['tools', 'systemPrompt', 'agents', 'approval']

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig - the Loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  hostLog(`apply: start (v${VERSION})`)

  const config = normalizeConfig(rawConfig)
  const state = createState(ctx, config)

  try {
    ctx.effect(() => ctx.systemPrompt.section(createPromptSection(config)), 'approval-preflight: prompt section')

    ctx.effect(() => {
      const disposers = createTools(state, config).map((tool) => ctx.tools.register(tool))
      return () => {
        for (let index = disposers.length - 1; index >= 0; index -= 1) {
          try {
            disposers[index]()
          } catch {
            /* disposal must not throw out of the effect */
          }
        }
      }
    }, 'approval-preflight: tools')

    // Correlate an approval request with the arguments that triggered it, and
    // record every call that happens inside the running node's window.
    ctx.on('tools/pre-execute', (exec, next) => {
      state.rememberCall(exec)
      state.auditCall(exec)
      return next()
    })

    // Settle audit outcomes once the call finishes.
    ctx.on('tools/result', (exec, result) => state.noteResult(exec, result))

    // `prepend` matters: the native approval presenter is registered at boot, and
    // only a listener ahead of it can answer without showing the card.
    ctx.on('approval/request', (request, next) => state.decideApproval(request, next), { prepend: true })

    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (typeof id === 'string') state.dispose(id)
    })

    // The panel channel needs `connection` (for the auth fence) and `webServer`
    // (for the route). They may still be mounting when this plugin activates, so
    // the registration lives in an explicitly injected child plugin: that child
    // is what Cordis allows to read those two services.
    const handler = createRpcHandler(state)
    ctx.inject(['connection', 'webServer'], (scope) => {
      scope.effect(() => {
        try {
          return installChannel(scope, handler)
        } catch (error) {
          hostLog(`channel: install failed: ${error instanceof Error ? error.message : String(error)}`)
          return () => {}
        }
      }, 'approval-preflight: panel channel')
      hostLog(`apply: channel scope ready (${CHANNEL})`)
    })

    ctx.effect(() => () => state.disposeAll(), 'approval-preflight: state')

    hostLog(`apply: wired (v${VERSION}, channel=${CHANNEL})`)
  } catch (error) {
    hostLog(`apply: FAILED ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`)
    throw error
  }
}
