/**
 * Browser half of the approval-preflight bundle.
 *
 * Two registrations share one small store:
 *  - a compact strip above the composer that shows how many nodes wait for the
 *    user's approval;
 *  - a fixed side panel in `shell.overlay` that renders the computation graph,
 *    one card per node (essence, impacts, status, approval actions) and the audit
 *    trail of what actually ran inside a node.
 *
 * The panel is the only place an approval can originate. The model has no tool
 * that reaches this channel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-preflight',
  factory(require) {
    const React = require('react')
    const el = React.createElement
    const CHANNEL = '/dsh-approval-preflight'
    const POLL_MS = 2500

    // ---------------------------------------------------------------------
    // Shared store
    // ---------------------------------------------------------------------

    const store = {
      open: false,
      sessionId: undefined,
      data: null,
      error: '',
      busy: '',
      expanded: Object.create(null),
      autoOpenedFor: Object.create(null)
    }
    const listeners = new Set()
    let runtime = null

    function publish(patch) {
      Object.assign(store, patch)
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* one broken subscriber must not break the others */
        }
      }
    }

    function useShared() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return store
    }

    async function call(endpoint, payload) {
      if (runtime === null) throw new Error('插件尚未就绪（runtime 为空）')
      let result
      try {
        result = await runtime.connection.rpc.call(CHANNEL, endpoint, payload)
      } catch (error) {
        throw new Error(`[${endpoint}] 通道异常：${error?.message ?? String(error)}`)
      }
      if (result === null || typeof result !== 'object') throw new Error('预检通道返回为空')
      if (result.ok !== true) throw new Error(`[${endpoint}] ${result.error?.code ?? ''} ${result.error?.message ?? '预检通道调用失败'}`)
      return result.value
    }

    async function refresh(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      try {
        const data = await call('status', { sessionId })
        publish({ sessionId, data, error: '' })
        maybeAutoOpen(sessionId, data)
      } catch (error) {
        publish({ error: error?.message ?? String(error) })
      }
    }

    function maybeAutoOpen(sessionId, data) {
      if (data === null || typeof data !== 'object') return
      if ((data.counts?.proposed ?? 0) === 0) return
      if (store.autoOpenedFor[sessionId] === true) return
      store.autoOpenedFor[sessionId] = true
      publish({ open: true })
    }

    async function mutate(action, nodeIds) {
      const sessionId = store.sessionId
      if (typeof sessionId !== 'string') return
      publish({ busy: action })
      try {
        const result = await call(action, { sessionId, nodeIds })
        if (result?.view !== undefined) publish({ data: result.view, error: '' })
        else await refresh(sessionId)
      } catch (error) {
        publish({ error: error?.message ?? String(error) })
      } finally {
        publish({ busy: '' })
      }
    }

    // ---------------------------------------------------------------------
    // Labels
    // ---------------------------------------------------------------------

    const EFFECT_LABELS = {
      read: '只读', compute: '计算', download: '下载', write: '写入',
      delete: '删除', execute: '执行', network: '联网'
    }
    const IMPACT_LABELS = { 'fs-write': '写文件', 'fs-delete': '删除文件', exec: '执行命令', network: '网络' }
    const STATUS_LABELS = {
      proposed: '待批准', approved: '已批准', running: '执行中', suspended: '已挂起',
      done: '已完成', rejected: '已拒绝', revoked: '已撤销'
    }

    // ---------------------------------------------------------------------
    // Styles (theme tokens only — no literal colors except artwork-free shadows)
    // ---------------------------------------------------------------------

    const CSS = `
.dshap-strip{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dshap-strip-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px 2px 9px;font:inherit;cursor:pointer;}
.dshap-strip-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.dshap-strip-btn[data-open="true"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);}
.dshap-ok{color:var(--dsw-alias-state-success-primary);}
.dshap-warn{color:var(--dsw-alias-state-warn-primary);}
.dshap-sep{opacity:.45;}

.dshap-panel{position:fixed;top:64px;right:16px;bottom:auto;max-height:calc(100vh - 80px);width:min(468px,calc(100vw - 32px));z-index:40;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill);backdrop-filter:blur(18px) saturate(1.05);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.28);font-size:13px;overflow:hidden;}
.dshap-head{display:flex;align-items:center;gap:8px;padding:13px 14px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dshap-title{font-weight:600;font-size:13.5px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshap-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;}
.dshap-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dshap-meta{padding:11px 14px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dshap-goal{font-size:13px;line-height:1.5;margin-bottom:8px;word-break:break-word;}
.dshap-counts{display:flex;flex-wrap:wrap;gap:6px;}
.dshap-count{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dshap-count.todo{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:transparent;}
.dshap-count.run{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);border-color:transparent;}
.dshap-count.done{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);border-color:transparent;}
.dshap-count.susp{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);border-color:transparent;}

.dshap-graph-wrap{padding:10px 14px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dshap-graph-label{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.dshap-graph-label .sp{flex:1 1 auto;}
.dshap-levels{display:flex;align-items:flex-start;gap:6px;overflow:auto;max-height:128px;padding:6px 2px 8px;}
.dshap-level{display:flex;align-items:center;gap:6px;flex:0 0 auto;}
.dshap-lv-dots{display:flex;flex-direction:column;gap:6px;}
.dshap-lv-arrow{color:var(--dsw-alias-label-secondary);opacity:.45;font-size:11px;line-height:1;}
.dshap-dot2{width:29px;height:29px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-family:ui-monospace,Consolas,monospace;border:1.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative;z-index:1;flex:0 0 auto;}
.dshap-dot2[data-status="done"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
.dshap-dot2[data-status="running"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}
.dshap-dot2[data-status="proposed"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshap-dot2[data-status="approved"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshap-dot2[data-status="rejected"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}
.dshap-dot2[data-status="suspended"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);border-style:dashed;}
.dshap-dot2 .badge{position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-specific-sidebar-fill);}

.dshap-body{overflow-y:auto;padding:10px 12px 14px;display:flex;flex-direction:column;gap:8px;}
.dshap-body::-webkit-scrollbar{width:8px;}
.dshap-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1);border-radius:8px;}
.dshap-node{position:relative;padding-left:18px;}
.dshap-node::before{content:"";position:absolute;left:5px;top:14px;width:9px;height:9px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-sidebar-fill);}
.dshap-node[data-status="proposed"]::before{border-color:var(--dsw-alias-brand-primary);}
.dshap-node[data-status="approved"]::before{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);}
.dshap-node[data-status="running"]::before{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-primary);}
.dshap-node[data-status="done"]::before{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);}
.dshap-node[data-status="rejected"]::before{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);}
.dshap-node[data-status="suspended"]::before{border-color:var(--dsw-alias-state-warn-primary);}
.dshap-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:11px;padding:9px 10px 8px;}
.dshap-node[data-status="proposed"] .dshap-card{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));}
.dshap-node[data-status="running"] .dshap-card{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-border-l1));}
.dshap-node[data-status="suspended"] .dshap-card{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));}
.dshap-suspend{margin-top:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);word-break:break-word;}
.dshap-switch{margin-top:2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.dshap-card-top{display:flex;align-items:center;gap:7px;}
.dshap-effect{flex:0 0 auto;font-size:10.5px;line-height:18px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dshap-effect[data-kind="download"]{color:var(--dsw-alias-brand-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);}
.dshap-effect[data-kind="write"]{color:var(--dsw-alias-brand-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);}
.dshap-effect[data-kind="execute"]{color:var(--dsw-alias-state-warn-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);}
.dshap-effect[data-kind="delete"]{color:var(--dsw-alias-state-error-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);}
.dshap-nid{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);}
.dshap-node-title{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.4;font-weight:500;word-break:break-word;}
.dshap-state{flex:0 0 auto;font-size:10.5px;padding:1px 8px;border-radius:999px;line-height:17px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.dshap-state.proposed{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);}
.dshap-state.approved{color:var(--dsw-alias-brand-primary);}
.dshap-state.running{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);}
.dshap-state.done{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);}
.dshap-state.rejected,.dshap-state.revoked{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);}
.dshap-state.suspended{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);}
.dshap-essence{margin-top:5px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.dshap-essence b{color:var(--dsw-alias-label-primary);font-weight:500;}
.dshap-arrow{opacity:.5;margin:0 4px;}
.dshap-note{margin-top:2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.85;word-break:break-word;}
.dshap-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.dshap-tag{font-size:10.5px;line-height:17px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dshap-tag.impact{color:var(--dsw-alias-brand-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}
.dshap-tag.escalate{color:var(--dsw-alias-state-error-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);}
.dshap-actions{display:flex;align-items:center;gap:6px;margin-top:8px;}
.dshap-btn{flex:0 0 auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:20px;padding:1px 10px;cursor:pointer;}
.dshap-btn:hover{border-color:var(--dsw-alias-border-l2);}
.dshap-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;}
.dshap-btn[data-variant="ghost"]{border-color:transparent;color:var(--dsw-alias-label-secondary);background:transparent;}
.dshap-btn[disabled]{opacity:.45;cursor:default;}
.dshap-spacer{flex:1 1 auto;}
.dshap-expand{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;padding:2px 4px;cursor:pointer;font-family:inherit;}
.dshap-expand:hover{color:var(--dsw-alias-label-primary);}
.dshap-audit{margin-top:7px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:7px;display:flex;flex-direction:column;gap:4px;}
.dshap-audit-title{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);opacity:.8;}
.dshap-audit-row{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);}
.dshap-audit-row .tool{font-family:ui-monospace,Consolas,monospace;font-size:10px;flex:0 0 62px;opacity:.8;}
.dshap-audit-row .ok{color:var(--dsw-alias-state-success-primary);}
.dshap-audit-row .err{color:var(--dsw-alias-state-error-primary);}
.dshap-audit-row .blocked{color:var(--dsw-alias-state-warn-primary);}
.dshap-audit-row .summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshap-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}
.dshap-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85;}
.dshap-ver{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);opacity:.65;font-family:ui-monospace,Consolas,monospace;}
.dshap-empty{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
.dshap-error{margin:0 0 8px;padding:7px 9px;border-radius:8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);}
.dshap-kbd{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 5px;line-height:15px;}
.dshap-flash{animation:dshapFlash .9s ease;}
@keyframes dshapFlash{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);}35%{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);}100%{box-shadow:0 0 0 0 transparent;}}
`

    function installStyles(ctx) {
      ctx.effect(() => {
        const existing = document.head.querySelector(`style[data-plugin="${CHANNEL}"]`)
        if (existing !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = CHANNEL
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'approval-preflight: styles')
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    const shield = (props) =>
      el('svg', { viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true, ...props },
        el('path', { d: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z' }),
        el('path', { d: 'M9 12l2.2 2.2L15.5 10' }))

    /**
     * Group nodes into dependency layers: column 0 has no prerequisites, column N
     * needs something from the previous ones. Sequential work reads as a flow;
     * independent branches stack in the same column — exactly the split the
     * auto-switch uses when a permission stalls.
     */
    function graphLayers(nodes) {
      const byId = new Map(nodes.map((node) => [node.id, node]))
      const depth = new Map()
      function visit(id, seen) {
        if (depth.has(id)) return depth.get(id)
        const node = byId.get(id)
        if (node === undefined || seen.has(id)) return 0
        seen.add(id)
        let level = 0
        for (const dep of node.dependsOn ?? []) level = Math.max(level, visit(dep, seen) + 1)
        depth.set(id, level)
        return level
      }
      for (const node of nodes) visit(node.id, new Set())
      const layers = []
      for (const node of nodes) {
        const level = depth.get(node.id) ?? 0
        if (layers[level] === undefined) layers[level] = []
        layers[level].push(node)
      }
      return layers.filter((layer) => layer !== undefined)
    }

    function essenceText(node) {
      const parts = []
      if (node.essence?.action) parts.push(String(node.essence.action))
      if (node.essence?.source) parts.push(el('span', { key: 'src' }, '来源 · ', el('b', null, node.essence.source)))
      if (node.essence?.target) parts.push(el('span', { key: 'tgt' }, '目标 · ', el('b', null, node.essence.target)))
      if (node.essence?.details) parts.push(el('span', { key: 'det' }, node.essence.details))
      const out = []
      parts.forEach((part, index) => {
        if (index > 0) out.push(el('span', { className: 'dshap-arrow', key: `a${index}` }, '/'))
        out.push(typeof part === 'string' ? el('span', { key: `p${index}` }, part) : part)
      })
      return out
    }

    function impactTags(node) {
      const tags = (node.impacts ?? []).map((impact) =>
        el('span', { className: 'dshap-tag impact', key: `i:${impact}` }, IMPACT_LABELS[impact] ?? impact))
      if (node.escalate === true) tags.push(el('span', { className: 'dshap-tag escalate', key: 'esc' }, '需完全访问'))
      if ((node.dependsOn ?? []).length > 0) {
        tags.push(el('span', { className: 'dshap-tag', key: 'dep' }, `依赖 ${node.dependsOn.join('、')}`))
      }
      if ((node.dependents ?? []).length > 0) {
        tags.push(el('span', { className: 'dshap-tag', key: 'deps' }, `后续 ${node.dependents.join('、')}`))
      }
      if (node.permission === 'none') tags.push(el('span', { className: 'dshap-tag', key: 'none' }, '无需权限'))
      return tags
    }

    function auditRow(entry, index) {
      const outcome = entry.outcome === 'ok' ? 'ok' : entry.outcome === 'error' ? 'err' : entry.outcome === 'blocked' ? 'blocked' : ''
      const mark = entry.outcome === 'ok' ? '✓' : entry.outcome === 'error' ? '×' : entry.outcome === 'blocked' ? '⏸' : '·'
      return el('div', { className: 'dshap-audit-row', key: `au${index}` },
        el('span', { className: 'tool' }, entry.tool ?? ''),
        el('span', { className: 'summary', title: entry.summary ?? '' }, entry.summary ?? ''),
        el('span', { className: outcome }, mark))
    }

    // ---------------------------------------------------------------------
    // Composer strip
    // ---------------------------------------------------------------------

    function Strip(props) {
      const shared = useShared()
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined

      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        publish({ sessionId })
        refresh(sessionId)
        const timer = setInterval(() => refresh(sessionId), POLL_MS)
        return () => clearInterval(timer)
      }, [sessionId])

      if (sessionId === undefined) return null
      const data = shared.data
      const hasGraph = data !== null && typeof data === 'object' && data.hasGraph === true
      if (!hasGraph && shared.open !== true) return null
      const proposed = data?.counts?.proposed ?? 0
      const running = data?.counts?.running ?? 0
      const suspended = data?.counts?.suspended ?? 0
      const total = data?.counts?.total ?? 0
      const done = data?.counts?.done ?? 0

      return el('div', { className: 'dshap-strip' },
        el('button', {
          type: 'button',
          className: 'dshap-strip-btn',
          'data-open': shared.open === true ? 'true' : 'false',
          title: '打开计算图与权限预检面板',
          onClick: () => publish({ open: shared.open !== true })
        },
        shield(),
        el('span', null, '预检'),
        el('span', { className: 'dshap-sep' }, '·'),
        running > 0
          ? el('span', { className: 'dshap-warn' }, '执行中')
          : suspended > 0
            ? el('span', { className: 'dshap-warn' }, `${suspended} 项已挂起`)
            : proposed > 0
              ? el('span', { className: 'dshap-warn' }, `${proposed} 项待批准`)
              : el('span', { className: 'dshap-ok' }, '权限就绪'),
        el('span', { className: 'dshap-sep' }, '·'),
        el('span', null, `${done}/${total} 完成`)))
    }

    // ---------------------------------------------------------------------
    // Side panel
    // ---------------------------------------------------------------------

    function Panel() {
      const shared = useShared()

      React.useEffect(() => {
        if (shared.open !== true) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') publish({ open: false })
        }
        window.addEventListener('keydown', onKeyDown)
        if (typeof shared.sessionId === 'string') refresh(shared.sessionId)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [shared.open, shared.sessionId])

      if (shared.open !== true) return null

      const data = shared.data
      const nodes = Array.isArray(data?.nodes) ? data.nodes : []
      const switchable = Array.isArray(data?.switchable) ? data.switchable : []
      const busy = shared.busy
      const proposedIds = nodes.filter((node) => node.status === 'proposed').map((node) => node.id)

      function toggle(id) {
        const next = { ...store.expanded }
        if (next[id] === true) delete next[id]
        else next[id] = true
        publish({ expanded: next })
      }

      function jump(id) {
        const target = document.getElementById(`dshap-node-${id}`)
        if (target !== null) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          target.classList.add('dshap-flash')
          setTimeout(() => target.classList.remove('dshap-flash'), 1000)
        }
      }

      return el('div', { className: 'dshap-panel', role: 'dialog', 'aria-label': '计算图与权限预检' },
        el('div', { className: 'dshap-head' },
          shield({ style: { color: 'var(--dsw-alias-brand-primary)' } }),
          el('span', { className: 'dshap-title' }, '计算图与权限预检'),
          el('button', { type: 'button', className: 'dshap-icon-btn', title: '关闭（Esc）', onClick: () => publish({ open: false }) }, '×')),

        el('div', { className: 'dshap-meta' },
          el('div', { className: 'dshap-goal' }, data?.goal ? `目标：${data.goal}` : '还没有登记计算图'),
          el('div', { className: 'dshap-counts' },
            el('span', { className: 'dshap-count todo' }, `${data?.counts?.proposed ?? 0} 待批准`),
            el('span', { className: 'dshap-count run' }, `${data?.counts?.running ?? 0} 执行中`),
            (data?.counts?.suspended ?? 0) > 0
              ? el('span', { className: 'dshap-count susp' }, `${data?.counts?.suspended ?? 0} 已挂起`)
              : null,
            el('span', { className: 'dshap-count done' }, `${data?.counts?.done ?? 0} 已完成`),
            el('span', { className: 'dshap-count' }, `${data?.counts?.total ?? 0} 个节点`))),

        data !== null && nodes.length > 0
          ? el('div', { className: 'dshap-graph-wrap' },
              el('div', { className: 'dshap-graph-label' },
                el('span', null, '计算图'), el('span', { className: 'sp' }), el('span', null, '按依赖分层 · 点击跳转')),
              el('div', { className: 'dshap-levels' }, graphLayers(nodes).map((layer, index) =>
                el('div', { className: 'dshap-level', key: `lv:${index}` },
                  index > 0 ? el('span', { className: 'dshap-lv-arrow' }, '→') : null,
                  el('div', { className: 'dshap-lv-dots' }, layer.map((node) =>
                    el('div', {
                      key: `dot:${node.id}`,
                      className: 'dshap-dot2',
                      'data-status': node.status,
                      title: `${node.id} · ${node.title}${(node.dependsOn ?? []).length > 0 ? `（前置 ${node.dependsOn.join('、')}）` : ''}`,
                      onClick: () => jump(node.id)
                    }, node.id, node.status === 'proposed' ? el('span', { className: 'badge' }) : null)))))))
          : null,

        el('div', { className: 'dshap-body' },
          shared.error !== '' ? el('div', { className: 'dshap-error' }, shared.error) : null,
          data === null
            ? el('div', { className: 'dshap-empty' }, '正在读取预检状态…')
            : nodes.length === 0
              ? el('div', { className: 'dshap-empty' },
                  '这个会话还没有计算图。',
                  el('br'),
                  '当需求涉及写文件、执行命令或联网时，模型会先调用 preflight_graph 把「要做的事 + 会碰什么」列出来，你再逐节点批准。')
              : nodes.map((node) => {
                  const expanded = shared.expanded[node.id] === true
                  const audit = Array.isArray(node.audit) ? node.audit : []
                  const actions = []
                  if (node.status === 'proposed') {
                    actions.push(el('button', {
                      key: 'approve', type: 'button', className: 'dshap-btn', 'data-variant': 'primary',
                      disabled: busy !== '', onClick: () => mutate('approve', [node.id])
                    }, '批准'))
                    actions.push(el('button', {
                      key: 'reject', type: 'button', className: 'dshap-btn',
                      disabled: busy !== '', onClick: () => mutate('reject', [node.id])
                    }, '拒绝'))
                  } else if (node.status === 'approved' || node.status === 'suspended') {
                    actions.push(el('button', {
                      key: 'revoke', type: 'button', className: 'dshap-btn', 'data-variant': 'ghost',
                      disabled: busy !== '', onClick: () => mutate('revoke', [node.id])
                    }, '撤销批准'))
                  }
                  return el('div', {
                    key: node.id, className: 'dshap-node', 'data-status': node.status, id: `dshap-node-${node.id}`
                  },
                    el('div', { className: 'dshap-card' },
                      el('div', { className: 'dshap-card-top' },
                        el('span', { className: 'dshap-effect', 'data-kind': node.effect }, EFFECT_LABELS[node.effect] ?? node.effect),
                        el('span', { className: 'dshap-nid' }, node.id),
                        el('span', { className: 'dshap-node-title' }, node.title),
                        el('span', { className: `dshap-state ${node.status}` }, STATUS_LABELS[node.status] ?? node.status)),
                      el('div', { className: 'dshap-essence' }, essenceText(node)),
                      node.note ? el('div', { className: 'dshap-note' }, node.note) : null,
                      el('div', { className: 'dshap-tags' }, impactTags(node)),
                      node.status === 'suspended'
                        ? el('div', { className: 'dshap-suspend' },
                            `⏸ 已挂起：${node.suspendReason || '等待审批（批准保留）'}`)
                        : null,
                      node.status === 'suspended' && switchable.length > 0
                        ? el('div', { className: 'dshap-switch' }, `不依赖它的可做节点：${switchable.join('、')}`)
                        : null,
                      actions.length > 0 || audit.length > 0
                        ? el('div', { className: 'dshap-actions' },
                            actions,
                            el('span', { className: 'dshap-spacer' }),
                            audit.length > 0
                              ? el('button', { type: 'button', className: 'dshap-expand', onClick: () => toggle(node.id) },
                                  expanded ? '收起实际执行' : `查看实际执行 (${audit.length})`)
                              : null)
                        : null,
                      expanded && audit.length > 0
                        ? el('div', { className: 'dshap-audit' },
                            el('div', { className: 'dshap-audit-title' }, '实际执行痕迹'),
                            audit.map((entry, index) => auditRow(entry, index)))
                        : null))
                })),

        el('div', { className: 'dshap-foot' },
          el('button', {
            type: 'button', className: 'dshap-btn', 'data-variant': 'primary',
            disabled: busy !== '' || proposedIds.length === 0,
            onClick: () => mutate('approve', proposedIds)
          }, busy === 'approve' ? '批准中…' : proposedIds.length > 0 ? `批准全部待批准（${proposedIds.length}）` : '无待批准'),
          el('span', { className: 'dshap-hint' }, '批准的是「这件事」，不是某条命令'),
          el('span', { className: 'dshap-spacer' }),
          data?.plugin?.version
            ? el('span', { className: 'dshap-ver', title: `面板协议 ${data.plugin.protocol ?? ''}`.trim() }, `v${data.plugin.version}`)
            : null,
          el('span', { className: 'dshap-kbd' }, 'Esc')))
    }

    // ---------------------------------------------------------------------
    // Module
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        runtime = ctx
        installStyles(ctx)
        ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'approval-preflight-strip', order: 60 }, Strip)),
          'approval-preflight: composer strip')
        ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'approval-preflight-panel', order: 90 }, Panel)),
          'approval-preflight: side panel')
      }
    }
  }
})
