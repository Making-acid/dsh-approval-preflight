/**
 * The system-prompt section that teaches the graph-first workflow.
 *
 * Tool descriptions carry the schemas; this section carries the standing policy:
 * declare the graph before touching permissions, approve per node, run one node
 * at a time, and never spin on a node the user has not approved.
 */

const SECTION_NAME = 'approval-preflight:workflow'
const SECTION_ORDER = 3060

/**
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @returns {{name: string, order: number, text: string}}
 */
export function createPromptSection(config) {
  const timeout = config.approvalTimeoutSeconds > 0
    ? `超过 ${config.approvalTimeoutSeconds} 秒`
    : '（本会话未启用超时让路）'

  const text = `## 审批预检（计算图与节点授权）

本机装有审批预检插件。它把审批从「逐次打断」换成「先交计算图、用户逐节点批准」。用对了可以大幅减少等待，但**批准是按节点的语义给的，不是按命令给的**。

**开工前先交计算图。** 接到需求后先调用 preflight_graph：
- goal：一句话目标；
- nodes：计算图节点。read / compute 这类没有外部影响的节点也要列（用户需要看到全貌）；
- 会碰外部世界的节点必须写清**本质**：action（下载/写入/删除/执行）、source（从哪来）、target（到哪去/改什么）、details（这件事的具体内容）；
- impacts 写这件事预计会触发的影响类型（写文件/执行命令/网络），省略时按 effect 自动推断；
- 需要提权的节点把 escalate 设为 true；
- 不确定用哪条命令、哪个包管理器**不用写进节点**——用户批准的是「这件事」，命令是实现细节，写进 note 说明即可。

**逐节点执行。**
1. 只有用户已批准（面板点过）且依赖已完成的节点才能开始：调用 preflight_node_start{id}；
2. 同一时刻只能有一个节点在执行；执行期间，该节点声明的影响类型内的工具调用会被自动放行；
3. 做完调用 preflight_node_end{id, success}。成功即消耗这次批准；失败传 success:false，批准不消耗、可直接重试。
4. 被拒绝或撤销的节点不要重试，追加新节点或请用户重新批准。

**不要空转。** 如果有节点在等批准，先做已批准且可执行的节点；都做完了就结束本轮——用户批准后会自动唤醒你。${timeout}没有响应的审批会被让路：该调用会快速失败，你应切换到其它节点，或把真正需要的新操作追加到计算图（preflight_graph_append）再请用户批准，不要反复重试同一个调用。

**追加而不是重写。** 只有新增节点时用 preflight_graph_append；重写整份计算图（preflight_graph）会让所有已批准节点失效，需要用户重新批准。

**当前配置**：节点空闲超时 ${config.nodeIdleSeconds} 秒（超时自动关闭、不消耗批准）；单张计算图最多 ${config.maxNodes} 个节点。`

  return { name: SECTION_NAME, order: SECTION_ORDER, text }
}
