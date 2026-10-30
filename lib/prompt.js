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
  const suspendRule = config.approvalTimeoutSeconds > 0
    ? `**挂起与切换。** 节点在运行中遇到未申报的操作、审批超过 ${config.approvalTimeoutSeconds} 秒没有响应时，插件会自动**挂起**该节点（批准保留、执行槽位释放），并把「不依赖它的可做节点」直接告诉你。收到挂起通知后：
1. 立刻 preflight_node_start 那个独立节点继续干活，**不要重试**刚才失败的那个调用；
2. 之后随时可以 preflight_node_start 被挂起的节点继续（不需要重新批准）；
3. 若确实需要那个操作，用 preflight_graph_append 追加一个节点（写清它的本质）并请用户批准，批准后先做它。`
    : `**挂起与切换。** 本会话关闭了审批超时让路（approvalTimeoutSeconds=0），未申报的审批会一直等用户回答；遇到这种情况先结束本轮，不要空转。`

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

${suspendRule}

**不要空转。** 如果有节点在等批准，先做已批准且可执行的节点；都做完了就结束本轮——用户批准后会自动唤醒你。

**追加而不是重写。** 只有新增节点时用 preflight_graph_append；重写整份计算图（preflight_graph）会让所有已批准节点失效，需要用户重新批准。

**依赖要标清楚。** dependsOn 是自动切换的依据：某个节点被权限挡住时，插件只会把「依赖闭包里不含它」的节点当作可切换分支。把真实的前后依赖写进 dependsOn，切换才不会把未完成的前置当成可做的活。

**影响类型要按真实工具写。** effect 只是分类提示；真正决定放行的是 impacts。如果这件事实际会用命令/网络/写文件，而按 effect 的默认推断不包含它，就把 impacts 写全——例如「用 pwsh 删除文件」的影响类型是 exec，不是 delete 的默认 fs-delete；写错了节点就覆盖不到自己的实际操作。

**当前配置**：节点空闲超时 ${config.nodeIdleSeconds} 秒（超时自动挂起、不消耗批准）；单张计算图最多 ${config.maxNodes} 个节点。`

  return { name: SECTION_NAME, order: SECTION_ORDER, text }
}
