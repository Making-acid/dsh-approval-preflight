/**
 * Model-facing tools of the approval-preflight bundle.
 *
 * Three tools cover the loop: publish the plan table, read it back with its
 * grant state, and move a task between states. Grants themselves are never a
 * tool — only the user can grant, through the side panel or the native approval
 * card, so the model can never widen its own authority.
 */

import { CLASS_LABELS, GRANT_CLASSES, labelOf } from './classes.js'
import { TASK_STATES } from './plan.js'

const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false }

const CLASS_ENUM = [...GRANT_CLASSES]

const VIEW_PROPERTIES = {
  ok: { type: 'boolean' },
  hasPlan: { type: 'boolean' },
  goal: { type: 'string' },
  required: { type: 'array', items: { type: 'string' } },
  granted: { type: 'array', items: { type: 'string' } },
  missing: { type: 'array', items: { type: 'string' } },
  pending: { type: 'array', items: { type: 'string' } },
  readyNow: { type: 'array', items: { type: 'string' } },
  text: { type: 'string' },
  instruction: { type: 'string' },
  errors: { type: 'array', items: { type: 'string' } },
  reason: { type: 'string' }
}

const VIEW_OUTPUT = { type: 'object', additionalProperties: true, properties: VIEW_PROPERTIES }

function textBlocks(text) {
  return [{ type: 'text', text: typeof text === 'string' ? text : String(text ?? '') }]
}

function names(ids) {
  return ids.map((id) => labelOf(id).zh).join('、')
}

function instructionFor(view) {
  const parts = []
  if (!view.hasPlan) return ''
  if (view.missing.length > 0) {
    parts.push(
      `还需要用户授权：${names(view.missing)}。请在右侧「预检」面板点一下（或让用户点）；不要因此停下。`
    )
  } else {
    parts.push('所需权限类别都已授权，可以直接按计划执行。')
  }
  if (view.readyNow.length > 0) parts.push(`现在可开工：${view.readyNow.join('、')}。`)
  else if (view.blocked.length > 0) {
    parts.push('当前没有可开工的子任务：结束本轮等待授权即可，授权到达后会自动唤醒你，不要反复重试同一个调用。')
  }
  parts.push('子任务状态变化后调用 preflight_task 更新。')
  return parts.join('\n')
}

function renderResult(value) {
  const view = value !== null && typeof value === 'object' ? value : {}
  if (view.ok === false) {
    const errors = Array.isArray(view.errors) ? view.errors : []
    return `预检计划未登记：\n${errors.length > 0 ? errors.map((line) => `- ${line}`).join('\n') : `- ${view.reason ?? '未知原因'}`}`
  }
  const lines = [view.text ?? '（无计划表）']
  if (Array.isArray(view.granted) && view.granted.length > 0) lines.push(`已授权类别：${names(view.granted)}`)
  if (Array.isArray(view.missing) && view.missing.length > 0) lines.push(`待授权类别：${names(view.missing)}`)
  if (Array.isArray(view.pending) && view.pending.length > 0) lines.push(`超时挂起：${names(view.pending)}`)
  if (typeof view.instruction === 'string' && view.instruction.length > 0) lines.push('', view.instruction)
  return lines.join('\n')
}

/**
 * @param {ReturnType<import('./state.js').createState>} state
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function createTools(state, config) {
  return [planTool(state, config), statusTool(state), taskTool(state)]
}

function planTool(state, config) {
  void config
  return {
    name: 'preflight_plan',
    description:
      '登记本轮需求的「任务拆解 + 所需权限」计划表。凡是要多次写文件、执行命令或联网的任务，开工前先调用它：插件会告诉你哪些权限类别已授权、哪些等用户在右侧「预检」面板一次性确认，并列出当前可开工的子任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: '本次需求的一句话目标。' },
        tasks: {
          type: 'array',
          description: `子任务列表，最多 ${config.maxTasks} 项。传空数组表示清除当前计划表（任务完成后收尾用）。`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '短标识，1-16 位字母/数字/-/_，例如 T1。' },
              title: { type: 'string', description: '子任务标题。' },
              needs: {
                type: 'array',
                description: '该子任务需要的权限类别；不需要权限就留空数组。',
                items: { type: 'string', enum: CLASS_ENUM }
              },
              dependsOn: { type: 'array', description: '依赖的子任务 id。', items: { type: 'string' } },
              status: { type: 'string', enum: [...TASK_STATES], description: '初始状态，默认 pending。' }
            },
            required: ['id', 'title']
          }
        },
        note: { type: 'string', description: '可选备注，例如整体约束。' }
      },
      required: ['goal', 'tasks']
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => textBlocks(renderResult(value)) },
    presentCall: (args) => {
      const goal = typeof args?.goal === 'string' ? args.goal : ''
      const count = Array.isArray(args?.tasks) ? args.tasks.length : 0
      return { card: 'generic', title: `预检计划：${goal}`.slice(0, 96), kind: 'other', rawInput: { goal, count } }
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const result = state.setPlan(agent, args)
      if (!result.ok) return { ok: false, errors: result.errors }
      const view = result.view
      const instruction = result.cleared === true
        ? '计划表已清除，面板不再显示上一轮任务。'
        : instructionFor(view)
      return { ok: true, cleared: result.cleared === true, ...view, instruction }
    }
  }
}

function statusTool(state) {
  return {
    name: 'preflight_status',
    description:
      '查看当前会话的预检计划表：每个子任务的状态与所需权限、已授权/待授权/超时挂起的权限类别、当前可开工的子任务。遇到审批超时或想确认下一步能做什么时调用。',
    parameters: EMPTY_PARAMETERS,
    output: { schema: VIEW_OUTPUT, render: (_args, value) => textBlocks(renderResult(value)) },
    presentCall: () => ({ card: 'generic', title: '查看预检计划', kind: 'other' }),
    async execute(_args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const view = state.modelView(agent)
      return { ok: true, ...view, instruction: instructionFor(view) }
    }
  }
}

function taskTool(state) {
  return {
    name: 'preflight_task',
    description:
      '更新预检计划表里某个子任务的状态（pending / running / done / blocked）或备注，让用户和右侧面板看到真实进度。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '子任务 id。' },
        status: { type: 'string', enum: [...TASK_STATES], description: '新状态。' },
        note: { type: 'string', description: '可选备注，例如卡在哪里。' }
      },
      required: ['id']
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => textBlocks(renderResult(value)) },
    presentCall: (args) => ({
      card: 'generic',
      title: `更新子任务 ${typeof args?.id === 'string' ? args.id : ''}`.trim(),
      kind: 'other'
    }),
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const result = state.setTask(agent, args)
      if (!result.ok) return { ok: false, errors: [result.reason] }
      const view = result.view
      return { ok: true, ...view, instruction: instructionFor(view) }
    }
  }
}

/** Class labels, exported for the panel RPC payload. */
export const CLASS_LABEL_MAP = CLASS_LABELS
