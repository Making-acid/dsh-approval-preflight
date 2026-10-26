/**
 * Browser half of the approval-preflight bundle.
 *
 * Two registrations share one tiny store:
 *  - a compact strip in the composer dock that polls the Host and shows the
 *    plan's permission posture;
 *  - a fixed side panel in `shell.overlay` that renders the whole task/permission
 *    table and turns a permission class into a one-click grant.
 *
 * The panel is the only place a grant can originate from the UI; the Host only
 * accepts grants through this authenticated channel, and the model has no tool
 * that reaches it.
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
      const missing = data.counts?.missing ?? 0
      const pending = data.counts?.pending ?? 0
      if (missing === 0 && pending === 0) return
      if (store.autoOpenedFor[sessionId] === true) return
      store.autoOpenedFor[sessionId] = true
      publish({ open: true })
    }

    async function mutate(action, classes) {
      const sessionId = store.sessionId
      if (typeof sessionId !== 'string') return
      publish({ busy: action })
      try {
        const result = await call(action, { sessionId, classes })
        if (result?.view !== undefined) publish({ data: result.view, error: '' })
        else await refresh(sessionId)
      } catch (error) {
        publish({ error: error?.message ?? String(error) })
      } finally {
        publish({ busy: '' })
      }
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
.dshap-strip{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dshap-strip-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px 2px 8px;font:inherit;cursor:pointer;}
.dshap-strip-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.dshap-strip-btn[data-open="true"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);}
.dshap-strip-sep{opacity:.45;}
.dshap-strip-warn{color:var(--dsw-alias-state-warn-primary);}
.dshap-strip-ok{color:var(--dsw-alias-state-success-primary);}
.dshap-panel{position:fixed;top:64px;right:16px;bottom:auto;max-height:calc(100vh - 80px);width:min(420px,calc(100vw - 32px));z-index:40;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill);backdrop-filter:blur(18px) saturate(1.05);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.28);font-size:13px;overflow:hidden;}
.dshap-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dshap-title{font-weight:600;font-size:13px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshap-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;}
.dshap-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dshap-body{flex:1 1 auto;overflow-y:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:14px;}
.dshap-goal{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-word;}
.dshap-note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.dshap-section-title{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:2px;}
.dshap-row{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);}
.dshap-row + .dshap-row{margin-top:6px;}
.dshap-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}
.dshap-row-title{font-size:12.5px;line-height:1.4;word-break:break-word;}
.dshap-row-sub{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.dshap-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;margin-top:5px;background:var(--dsw-alias-state-idle-primary);}
.dshap-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary);}
.dshap-dot[data-state="warn"]{background:var(--dsw-alias-state-warn-primary);}
.dshap-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary);}
.dshap-dot[data-state="brand"]{background:var(--dsw-alias-brand-primary);}
.dshap-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 7px;font-size:10.5px;line-height:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dshap-chip[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);}
.dshap-chip[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);}
.dshap-chip[data-tone="brand"]{color:var(--dsw-alias-brand-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);}
.dshap-chip[data-tone="error"]{color:var(--dsw-alias-state-error-primary);border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);}
.dshap-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;}
.dshap-btn{flex:0 0 auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:1px 10px;cursor:pointer;}
.dshap-btn:hover{border-color:var(--dsw-alias-border-l2);}
.dshap-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;}
.dshap-btn[data-variant="primary"]:hover{filter:brightness(1.06);}
.dshap-btn[disabled]{opacity:.5;cursor:default;}
.dshap-btn[data-variant="ghost"]{border-color:transparent;color:var(--dsw-alias-label-secondary);}
.dshap-btn[data-variant="ghost"]:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.dshap-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}
.dshap-foot-spacer{flex:1 1 auto;}
.dshap-empty{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
.dshap-error{margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);}
.dshap-counts{display:flex;flex-wrap:wrap;gap:6px;}
.dshap-kbd{font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.75;}
`

    function installStyles(ctx) {
      ctx.effect(() => {
        const existing = document.head.querySelector(`style[data-plugin="${CHANNEL}"]`)
        if (existing !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = CHANNEL
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'approval-preflight: styles')
    }

    // ---------------------------------------------------------------------
    // Small presentational helpers
    // ---------------------------------------------------------------------

    function dot(state) {
      return el('span', { className: 'dshap-dot', 'data-state': state })
    }

    function chip(text, tone) {
      return el('span', { className: 'dshap-chip', 'data-tone': tone, key: `${tone}:${text}` }, text)
    }

    function classTone(row) {
      if (row.granted) return 'ok'
      if (row.pending) return 'warn'
      if (row.required) return 'brand'
      return 'idle'
    }

    function classStatusText(row) {
      if (row.granted) return '已授权，同类审批秒过'
      if (row.pending) return '等待中，超时后已挂起'
      if (row.required) return '本计划需要，点一下即可授权'
      return '本计划未申请'
    }

    function stateTone(state) {
      if (state === 'done') return 'ok'
      if (state === 'running') return 'brand'
      if (state === 'blocked') return 'error'
      return 'idle'
    }

    function stateText(state) {
      if (state === 'done') return '已完成'
      if (state === 'running') return '进行中'
      if (state === 'blocked') return '受阻'
      return '待办'
    }

    function needsChips(task) {
      if (!Array.isArray(task.needs) || task.needs.length === 0) return [chip('无需权限', 'ok')]
      return task.needs.map((need) => {
        const granted = Array.isArray(store.data?.classes)
          ? store.data.classes.find((item) => item.id === need)?.granted === true
          : false
        return chip(labelOfClass(need), granted ? 'ok' : 'brand')
      })
    }

    function labelOfClass(id) {
      const found = Array.isArray(store.data?.classes) ? store.data.classes.find((item) => item.id === id) : undefined
      return found?.label?.zh ?? id
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
      const hasPlan = data !== null && typeof data === 'object' && Array.isArray(data.tasks) && data.tasks.length > 0
      if (!hasPlan && shared.open !== true) return null

      const missing = data?.counts?.missing ?? 0
      const pending = data?.counts?.pending ?? 0
      const ready = data?.counts?.ready ?? 0

      return el(
        'div',
        { className: 'dshap-strip' },
        el(
          'button',
          {
            type: 'button',
            className: 'dshap-strip-btn',
            'data-open': shared.open === true ? 'true' : 'false',
            title: '打开任务与权限预检面板',
            onClick: () => publish({ open: shared.open !== true })
          },
          el('span', { 'aria-hidden': true }, '🛡'),
          el('span', null, '预检'),
          el('span', { className: 'dshap-strip-sep' }, '·'),
          missing > 0
            ? el('span', { className: 'dshap-strip-warn' }, `${missing} 项待授权`)
            : pending > 0
              ? el('span', { className: 'dshap-strip-warn' }, `${pending} 项等待中`)
              : el('span', { className: 'dshap-strip-ok' }, '权限就绪'),
          el('span', { className: 'dshap-strip-sep' }, '·'),
          el('span', null, `${ready} 个可开工`)
        )
      )
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
      const classes = Array.isArray(data?.classes) ? data.classes : []
      const tasks = Array.isArray(data?.tasks) ? data.tasks : []
      const missingClasses = classes.filter((row) => row.required && !row.granted).map((row) => row.id)
      const busy = shared.busy

      return el(
        'div',
        { className: 'dshap-panel', role: 'dialog', 'aria-label': '任务与权限预检' },
        el(
          'div',
          { className: 'dshap-head' },
          el('span', { 'aria-hidden': true }, '🛡'),
          el('span', { className: 'dshap-title' }, '任务与权限预检'),
          el(
            'button',
            {
              type: 'button',
              className: 'dshap-icon-btn',
              title: '关闭（Esc）',
              onClick: () => publish({ open: false })
            },
            '×'
          )
        ),
        el(
          'div',
          { className: 'dshap-body' },
          shared.error !== '' ? el('div', { className: 'dshap-error' }, shared.error) : null,
          data === null
            ? el('div', { className: 'dshap-empty' }, '正在读取预检状态…')
            : tasks.length === 0
              ? el(
                  'div',
                  { className: 'dshap-empty' },
                  '这个会话还没有登记计划表。',
                  el('br'),
                  '当需求涉及多次写文件、执行命令或联网时，模型会在开工前调用 preflight_plan，把任务拆解和所需权限登记到这里。'
                )
              : el(
                  'div',
                  null,
                  el('div', { className: 'dshap-section-title' }, '目标'),
                  el('div', { className: 'dshap-goal' }, data.goal || '(未填写)'),
                  data.note ? el('div', { className: 'dshap-note' }, data.note) : null,
                  el('div', { className: 'dshap-counts', style: { marginTop: '8px' } }, [
                    chip(`${data.counts?.tasks ?? tasks.length} 个子任务`, 'idle'),
                    chip(`${data.counts?.ready ?? 0} 个可开工`, 'ok'),
                    (data.counts?.missing ?? 0) > 0 ? chip(`${data.counts.missing} 项待授权`, 'brand') : null,
                    (data.counts?.pending ?? 0) > 0 ? chip(`${data.counts.pending} 项等待中`, 'warn') : null
                  ].filter(Boolean))
                ),
          data !== null && tasks.length > 0
            ? el(
                'div',
                null,
                el('div', { className: 'dshap-section-title' }, '权限类别'),
                classes.map((row) =>
                  el(
                    'div',
                    { className: 'dshap-row', key: `class:${row.id}` },
                    dot(classTone(row)),
                    el(
                      'div',
                      { className: 'dshap-row-main' },
                      el('div', { className: 'dshap-row-title' }, row.label?.zh ?? row.id),
                      el(
                        'div',
                        { className: 'dshap-row-sub' },
                        classStatusText(row),
                        row.label?.hintZh ? ` · ${row.label.hintZh}` : ''
                      )
                    ),
                    row.granted
                      ? el(
                          'button',
                          {
                            type: 'button',
                            className: 'dshap-btn',
                            'data-variant': 'ghost',
                            disabled: busy !== '',
                            onClick: () => mutate('revoke', [row.id])
                          },
                          '撤销'
                        )
                      : el(
                          'button',
                          {
                            type: 'button',
                            className: 'dshap-btn',
                            'data-variant': row.required || row.pending ? 'primary' : undefined,
                            disabled: busy !== '',
                            onClick: () => mutate('grant', [row.id])
                          },
                          busy === 'grant' ? '授权中…' : '授权'
                        )
                  )
                )
              )
            : null,
          data !== null && tasks.length > 0
            ? el(
                'div',
                null,
                el('div', { className: 'dshap-section-title' }, '子任务'),
                tasks.map((task) =>
                  el(
                    'div',
                    { className: 'dshap-row', key: `task:${task.id}` },
                    dot(task.state === 'done' ? 'ok' : task.ready ? 'brand' : task.state === 'blocked' ? 'error' : 'idle'),
                    el(
                      'div',
                      { className: 'dshap-row-main' },
                      el(
                        'div',
                        { className: 'dshap-row-title' },
                        `${task.id} · ${task.title}`,
                        task.ready ? ' ' : '',
                        task.ready ? chip('可开工', 'ok') : null
                      ),
                      el(
                        'div',
                        { className: 'dshap-row-sub' },
                        `${stateText(task.state)}`,
                        task.missingDeps.length > 0 ? ` · 等前置 ${task.missingDeps.join('/')}` : '',
                        task.note ? ` · ${task.note}` : ''
                      ),
                      el('div', { className: 'dshap-chips' }, needsChips(task))
                    )
                  )
                )
              )
            : null
        ),
        el(
          'div',
          { className: 'dshap-foot' },
          el(
            'button',
            {
              type: 'button',
              className: 'dshap-btn',
              'data-variant': 'primary',
              disabled: busy !== '' || missingClasses.length === 0,
              onClick: () => mutate('grant', missingClasses)
            },
            busy === 'grant' ? '授权中…' : missingClasses.length > 0 ? `全部授权（${missingClasses.length}）` : '已全部授权'
          ),
          el('span', { className: 'dshap-foot-spacer' }),
          el('span', { className: 'dshap-kbd' }, 'Esc 关闭'),
          el(
            'button',
            {
              type: 'button',
              className: 'dshap-btn',
              'data-variant': 'ghost',
              disabled: busy !== '',
              onClick: () => refresh(shared.sessionId)
            },
            '刷新'
          )
        )
      )
    }

    // ---------------------------------------------------------------------
    // Module
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        runtime = ctx
        installStyles(ctx)
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'approval-preflight-strip',
                  order: 60
                },
                Strip
              )
            ),
          'approval-preflight: composer strip'
        )
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'approval-preflight-panel',
                  order: 90
                },
                Panel
              )
            ),
          'approval-preflight: side panel'
        )
      }
    }
  }
})
