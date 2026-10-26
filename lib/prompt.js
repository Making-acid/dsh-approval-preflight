/**
 * The system-prompt section that teaches the plan-first workflow.
 *
 * Tool descriptions carry the call schema; this section carries the standing
 * policy: plan before touching permissions, never spin on a blocked approval,
 * and go back to the table instead of asking the user again.
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

  const text = `## 审批预检（Approval Preflight）

本机装有审批预检插件：它把「逐次审批」换成「开工前按权限类别批量授权」。用好了可以大幅减少打断；用法如下。

**开工前先列表。** 当一个需求会涉及多次写文件、执行命令或联网时，先调用 preflight_plan，提交：
- goal：一句话目标；
- tasks：子任务数组，每项含 id（短标识）、title、needs（需要哪些权限类别：fs-write 写文件 / exec 执行命令 / network 联网 / danger 危险全权）、dependsOn（依赖的子任务 id）。

preflight_plan 会返回哪些类别已授权、哪些还在等用户在右侧「预检」面板确认。

**不要因为等授权而空转。**
- 先执行返回结果里 readyNow 的子任务；
- 被未授权项挡住、又没有可做的子任务时，直接结束本轮即可——用户授权后插件会自动唤醒你，不要反复重试同一个调用；
- 用户也可能继续用原生审批卡逐次批准，那是正常路径。

**维护计划表。** 子任务状态变化时调用 preflight_task（status: pending / running / done / blocked），让你自己和用户都看到真实进度。

**遇到超时或被拒绝。** 工具结果出现「审批等待超时」之类字样时，先调用 preflight_status 查看是否出现了新的待授权项；能换任务就换任务，确实无法继续再向用户说明。${timeout}内没有响应的审批会被插件挂起为「待授权」，授权到达时你会收到一条新的用户消息。

**权限类别只放行它覆盖的范围。** 用户授予的是类别，不是单条命令；不确定某步是否落在已授权类别里时，看 preflight_status 的 classes 列表，不要假设。

当前启用的权限类别：${config.enabledClasses.join('、')}。`

  return { name: SECTION_NAME, order: SECTION_ORDER, text }
}
