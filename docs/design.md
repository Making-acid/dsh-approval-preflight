# 审批预检插件 · 设计说明

> **注意**：本文写作于 1.0（按权限类别授权）。2.0 已改为「计算图 + 语义节点 + 节点级一次性授权」，
> 授权模型以 [`grant-model.md`](grant-model.md) 为准；本文保留下来的价值是**平台机制与踩坑记录**（第 3、5、6 节），
> 其中「按类别授权」的设计已被证伪，仅作历史参考。

写给未来的自己（以及在这个目录里继续加插件的同事）。记录**为什么这样设计**，以及踩到的平台机制坑。

## 1. 问题

vibe coding 里真正拖慢速度的往往不是模型能力，而是**审批请求没人及时点**：工具调用同步等待授权，用户不在电脑前，整轮就停在那里。

## 2. 目标行为

1. 模型拿到需求后，先把任务拆成表，并预测每个子任务需要哪类权限；
2. 用户**一次性**授权若干权限类别（而不是逐条命令点 N 次）；
3. 之后同类审批由插件直接答复，用户不再被打断；
4. 万一还是出现未覆盖的审批，等一小段时间后让模型**先去干别的**，别空等；
5. 用户后来点了允许，也要把这次授权**升级成常驻授权**并唤醒模型继续。

关键约束（用户明确要求）：**授权只能是用户动作**，模型永远不能给自己加权限；插件完全独立，不改内建 plan 模式。

## 3. 平台事实（都已核实，来自源码而非猜测）

| 事实 | 影响 |
| --- | --- |
| `ApprovalOutcome` 只有 `allowed-once` / `rejected` / `cancelled` / `unavailable`，**没有会话级授权** | 授权账本必须由插件自己维护；命中即返回 `allowed-once` |
| `approval.request()` 必须在 turn 打开时调用 | 插件不能由 UI 或定时器主动发起审批；预授权只能走「用户点面板」这条路 |
| `ApprovalRequestEvent` 只带 `toolName` / `callId` / `reason`，**不带参数** | 分类必须靠 `tools/pre-execute` 里记下的 `callId → arguments` 关联 |
| `approval/request` 是 waterfall，`ctx.on(..., { prepend: true })` 可排在原生审批器之前 | 已授权类别能在卡片出现前被拦下 |
| `approval.request()` 用一个 `Promise.race` 等 answerer | 我们的 listener 返回 `rejected` 即可让工具快速失败，模型继续；原生卡片留在那里，用户迟到点击仍会 resolve 我们持有的那个 promise |
| 工具运行时把 `approval.request()` 的结果一对一映射：`allowed-once` → 允许，`rejected` → 拒绝（原因文案固定） | 让路的文案只能靠紧随其后的 `agent.inject()` 引导消息补充 |
| `agent.inject()` 进 next-step 不唤醒；`agent.followup()` 进 next-turn 并唤醒 | 让路引导用 inject；授权到达用 followup |
| `agent/inbox/spliced` 事件持久保存插入的消息内容 | 把授权标记写进注入消息，就能从日志重建授权 |
| 会话日志里的 `tool/call` 保存工具参数 | 计划表天然可重建，不需要第二套存储 |

## 4. 架构

```
模型 ──preflight_plan──▶ 计划表(state) ──▶ 面板(status 轮询)
   │                        │
   │                        └──grant(用户点击)──▶ 授权账本 + followup 唤醒模型
   │
   └─工具调用──▶ tools/pre-execute(记录 callId→参数)
                     │
        审批请求 ──▶ approval/request waterfall (prepend)
                     ├─ 类别已授权 → 'allowed-once'
                     ├─ 未授权 → 竞争：原生 answerer vs 超时
                     │             └ 超时 → 挂起 + inject 引导 + 'rejected'
                     └─ 迟到 allowed-once → 转常驻授权 + followup
```

三层职责：

- **lib/state.js**：唯一的会话状态机。授权账本、挂起列表、callId 关联表、超时计时器、日志重建。所有入口都包了 try/catch——插件故障绝不能影响工具调用本身。
- **client.js**：输入框上方状态条（`conversation.input.dock`）+ 侧面板（`shell.overlay`，`position: fixed`）。面板 2.5s 轮询一次 `status`。
- **lib/channel.js**：面板通道。**没有用**宿主的 `connection.rpc.handle`（见下），而是自己在 `webServer` 注册前缀路由，说同样的 `client-request` / `server-response` 信封，认证复用 `connection.admit()`（同一套 Host/Origin 栅栏 + 浏览器凭据）。

## 5. 踩到的坑（重要，下次直接绕开）

1. **`ctx.connection.rpc.handle()` 对第三方插件不可用。**
   它内部用 `owner = this.ctx`（Connection 服务自己的上下文）去 `owner.webServer.register(...)`，而那个上下文没有注入 `webServer`，于是抛
   `cannot get property "webServer" without inject`。
   结论：第三方插件要用自己的 channel，就自己 `ctx.webServer.register` 并手动实现信封；认证用 `ctx.connection.admit()`。

2. **Cordis 禁止访问未声明的服务。**
   `ctx.agents` / `ctx.approval` / `ctx.tools` 等属性，只要没写进插件的 `inject`，访问就抛
   `cannot get property "x" without inject`。
   坑在于我们的 `agentOf()` 用 try/catch 兜底，把错误吞了 → 表现为「插件能跑但查不到会话」。**宁可让插件激活失败，也不要用 try/catch 掩盖 inject 缺失。**

3. **可选服务用嵌套注入。**
   需要 `connection` + `webServer` 的那段逻辑放在 `ctx.inject([...], (scope) => { scope.effect(...) })` 里，这样宿主缺少这些服务时核心能力（工具 + 审批拦截）仍然可用。

4. **Host 插件模块是 ESM 进程级缓存。**
   替换已加载过的包（改 `index.js`）不会热生效，必须重启应用；`remove_bundle` + `install_bundle` 也不行。
   开发期想反复迭代 Host 代码，就把整个包复制成新包名（模块 URL 全变）再装，验证完再切回正式包名。

5. **PowerShell 5.1 的 `Set-Content` 会把 UTF-8 中文写成乱码。**
   改仓库文件要么用编辑工具，要么 `[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($false))`。

6. **`approval/request` 的转发允许列表是应用级写死的。**
   第三方插件不能新增 `ctx.remote.$on` 的事件名；`approval/request` 与 `user-questions/request` 是仅有的两个 waterfall 转发项。

## 6. 为什么不接管原生审批卡

Client 调查给出了「方案 B」：在 `conversation.composer`（chain 槽）注册 `priority: 0` 的条目压过自带的 `ApprovalPanel`（priority 1），拿到 `PendingApproval` 直接 `answer()`。技术上可行，但：

- 会**替换掉用户熟悉的原生审批卡**，Harness 升级时容易跟着坏；
- 需要在 Client 侧复刻卡片交互（焦点、Esc、无障碍）。

1.0 选择保守路线：原生卡继续用，插件只在「已授权类别」和「超时让路」两个点上介入。等这套稳定后再评估接管。

## 7. 两个 spike 的结论（含被否决的方案）

### 7.1 KV 持久化：能力可达，但否决

实测：

| 场景 | 结果 |
| --- | --- |
| 从**工作区**目录 `import('@deepseek-ai/dsh-storage-domain')` | ❌ `ERR_MODULE_NOT_FOUND`（`zod` 同样失败） |
| 从**已安装位置**（profile `node_modules` 下的 junction） | ✅ 解析成功，导出 `defineDomain` / `domainTable` / `DomainFacility` / `apply` / `inject`，`zod` 可用 |

也就是说第三方插件**在运行时**确实能拿到 storage 层。仍然否决，三条理由：

1. **开发/测试与运行时分叉**：仓库里跑单测该 import 直接失败，只能改成 lazy import，于是「测过的代码」与「跑的代码」不是同一条路径；
2. **第二个真相源**：会话日志已经提供持久、可回放、带版本的真相（计划来自 `tool/call` 参数，授权来自注入消息里的标记），再加 KV 就要写迁移与对账，违背 practices 里「session log 是唯一真相」的原则；
3. **路由是组合级契约**：storage 后端的 route 由宿主组合给出，插件不能自己新增；若将来确实需要 KV，正确做法是向宿主提需求，而不是绕过去。

结论：保持「日志派生 + 内存缓存」。KV 留作跨会话统计需求出现时的备选。

### 7.2 tools.execute 后台补执行：契约成立，但 1.0 不做

源码层面已核实：`ctx.tools.execute()` 可在 turn 外调用，需要 `{callId, name, arguments, agent, signal}`，**不写 transcript**；若被派发的工具需要审批，turn 外的 `approval.request()` 会抛错并被吞成 `isError` 结果而不是整体失败。

不做它，是因为**结果回灌没有官方通道**（只能再开一个轮询工具让模型自己来取），而「超时让路 + 授权后重试」已经覆盖核心诉求：不空等、授权后零摩擦重试。真要做需要一次独立实机 spike，专门验证 turn 外派发、isError 语义、以及结果如何进入下一轮。

### 7.3 「结果改写」为什么变成「注入引导」

原设计打算用 `tools/post-execute` 把超时那条工具结果改写成「已让路」。实现时改成 `agent.inject()` 追加一条引导消息：

- 改写别人的结果要绑定该工具的结果文案结构，工具一升级就坏；注入是**追加**，与原生文案解耦；
- 原生结果里那句 "the user rejected tool X" 其实也是事实（这次确实没放行），紧跟的注入消息说明「不是用户拒绝，是等待超时」，模型不会误读。

代价是对话里多一条引导消息，可以接受。

## 8. 现状与下一步

- **已实现并验证**：计划表、批量预授权、即时放行、超时让路、迟到授权转常驻、日志重建、右侧面板；离线 80 项测试 + 一次真机全链路。
- **Projection 化**：当前授权账本是内存 + 日志重建；若要做跨会话统计，应改为 `ctx.sessionProjections` 单元。
- **准入细粒度**：目前 4 个粗粒度类别；若需要「只允许 `pnpm test*`」，在 `classOf` 上加规则引擎。
- **接管原生审批卡**：见第 6 节，等这套稳定后再评估。

