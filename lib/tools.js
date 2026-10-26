/**
 * Model-facing tools of the approval-preflight bundle.
 *
 * The model declares a computation graph, then walks it one node at a time. The
 * tools never grant anything: approvals only ever come from the user's panel.
 */

import { EFFECTS, IMPACTS } from './impacts.js'

const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false }

const NODE_PROPERTIES = {
  id: { type: 'string', description: '节点短标识，1–16 位字母/数字/-/_，例如 N2；后续工具用它引用。' },
  title: { type: 'string', description: '一句话标题，用户会在面板里看到。' },
  effect: {
    type: 'string',
    enum: [...EFFECTS],
    description: '这件事对外部世界的影响类别：read/compute 无影响；download/write/delete/execute/network 需要有影响描述。'
  },
  action: { type: 'string', description: '动作，例如「下载」「写入」「删除」「执行」。' },
  source: { type: 'string', description: '来源：下载/读取从哪里来（例如 npm registry · better-sqlite3）。' },
  target: { type: 'string', description: '目标：写到哪、删掉什么、对什么执行（例如 项目依赖目录、src/db.ts）。' },
  details: { type: 'string', description: '这件事的具体内容，用语义描述，不要写命令。' },
  note: { type: 'string', description: '可选边界说明，例如「不关心用 pnpm 还是 npm」。' },
  dependsOn: { type: 'array', description: '依赖的节点 id。', items: { type: 'string' } },
  impacts: {
    type: 'array',
    description: '预计触发的影响类型；省略时按 effect 自动推断。',
    items: { type: 'string', enum: [...IMPACTS] }
  },
  escalate: { type: 'boolean', description: '执行这件事是否需要提权（danger-full-access）。' },
  permission: {
    type: 'string',
    enum: ['required', 'none'],
    description: '是否需要用户批准；省略时按 effect 推断（read/compute 不需要）。'
  }
}

const GRAPH_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    hasGraph: { type: 'boolean' },
    goal: { type: 'string' },
    version: { type: 'integer' },
    running: { type: 'string' },
    pending: { type: 'array', items: { type: 'string' } },
    ready: { type: 'array', items: { type: 'string' } },
    text: { type: 'string' },
    instruction: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' }
  }
}

function textBlocks(text) {
  return [{ type: 'text', text: typeof text === 'string' ? text : String(text ?? '') }]
}

function renderView(value) {
  const view = value !== null && typeof value === 'object' ? value : {}
  if (view.ok === false) {
    const errors = Array.isArray(view.errors) ? view.errors : []
    return errors.length > 0
      ? `计算图登记失败：\n${errors.map((line) => `- ${line}`).join('\n')}`
      : `操作失败：${view.reason ?? '未知原因'}`
  }
  const lines = [view.text ?? '（无计算图）']
  if (typeof view.instruction === 'string' && view.instruction.length > 0) lines.push('', view.instruction)
  return lines.join('\n')
}

/**
 * @param {ReturnType<import('./state.js').createState>} state
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function createTools(state, config) {
  void config
  return [graphTool(state), appendTool(state), startTool(state), endTool(state), statusTool(state)]
}

function graphTool(state) {
  return {
    name: 'preflight_graph',
    description:
      '登记本轮的「计算图」：节点写清这件事的本质（动作 / 来源 / 目标），并标出会碰外部世界的节点。用户会在右侧面板逐节点批准。整份图重新提交会让旧批准失效；只加节点请用 preflight_graph_append。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: '本次需求的一句话目标。' },
        nodes: {
          type: 'array',
          description: '计算图节点，按依赖顺序排列。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: NODE_PROPERTIES,
            required: ['id', 'title']
          }
        }
      },
      required: ['goal', 'nodes']
    },
    output: { schema: GRAPH_SCHEMA, render: (_args, value) => textBlocks(renderView(value)) },
    presentCall: (args) => {
      const goal = typeof args?.goal === 'string' ? args.goal : ''
      const count = Array.isArray(args?.nodes) ? args.nodes.length : 0
      return { card: 'generic', title: `计算图：${goal}`.slice(0, 96), kind: 'other', rawInput: { goal, count } }
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const result = state.setGraph(agent, args)
      if (!result.ok) return { ok: false, errors: result.errors }
      return { ok: true, ...result.view }
    }
  }
}

function appendTool(state) {
  return {
    name: 'preflight_graph_append',
    description:
      '往当前计算图追加新节点（不提升版本、不影响已有批准）。做到一半发现要做新事时用它，并对新节点请用户批准。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodes: {
          type: 'array',
          description: '要追加的节点，id 不能与已有节点重复。',
          items: { type: 'object', additionalProperties: false, properties: NODE_PROPERTIES, required: ['id', 'title'] }
        }
      },
      required: ['nodes']
    },
    output: { schema: GRAPH_SCHEMA, render: (_args, value) => textBlocks(renderView(value)) },
    presentCall: (args) => ({
      card: 'generic',
      title: `追加节点 ${Array.isArray(args?.nodes) ? args.nodes.length : 0} 个`,
      kind: 'other'
    }),
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const result = state.appendGraph(agent, args?.nodes)
      if (!result.ok) return { ok: false, errors: result.errors }
      return { ok: true, ...result.view }
    }
  }
}

function startTool(state) {
  return {
    name: 'preflight_node_start',
    description:
      '声明开始执行某个已批准节点。同一时刻只能有一个节点在执行；只有用户已批准的节点才能开始。开始后，该节点声明的影响类型内的工具调用会自动放行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: '节点 id。' } },
      required: ['id']
    },
    output: { schema: GRAPH_SCHEMA, render: (_args, value) => textBlocks(renderView(value)) },
    presentCall: (args) => ({ card: 'generic', title: `开始节点 ${typeof args?.id === 'string' ? args.id : ''}`, kind: 'other' }),
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const result = state.startNode(agent, typeof args?.id === 'string' ? args.id : '')
      if (!result.ok) return { ok: false, reason: result.reason }
      return { ok: true, ...result.view }
    }
  }
}

function endTool(state) {
  return {
    name: 'preflight_node_end',
    description:
      '声明某个执行中的节点结束。success=true 表示成功，该节点的批准被消耗；success=false 表示失败，批准不消耗、可直接重试。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '节点 id。' },
        success: { type: 'boolean', description: '是否成功；默认 true。' }
      },
      required: ['id']
    },
    output: { schema: GRAPH_SCHEMA, render: (_args, value) => textBlocks(renderView(value)) },
    presentCall: (args) => ({
      card: 'generic',
      title: `结束节点 ${typeof args?.id === 'string' ? args.id : ''}${args?.success === false ? '（失败）' : ''}`,
      kind: 'other'
    }),
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      const result = state.endNode(agent, typeof args?.id === 'string' ? args.id : '', args?.success !== false)
      if (!result.ok) return { ok: false, reason: result.reason }
      return { ok: true, ...result.view }
    }
  }
}

function statusTool(state) {
  return {
    name: 'preflight_status',
    description: '查看当前计算图：每个节点的状态、哪些已批准可执行、哪些等待用户批准、当前执行中的节点。遇到审批超时或想知道下一步做什么时调用。',
    parameters: EMPTY_PARAMETERS,
    output: { schema: GRAPH_SCHEMA, render: (_args, value) => textBlocks(renderView(value)) },
    presentCall: () => ({ card: 'generic', title: '查看计算图', kind: 'other' }),
    async execute(_args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return { ok: false, errors: ['没有可用的会话上下文。'] }
      return { ok: true, ...state.modelView(agent) }
    }
  }
}
