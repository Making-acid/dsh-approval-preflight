# 审批预检 · dsh-approval-preflight

> 把「逐次审批」换成「开工前一次批完」，让模型不再因为没人点授权而干等。

DeepSeek Harness 的插件。它做三件事：

1. **计划表**：模型接到需求后先调用 `preflight_plan`，提交「子任务 × 所需权限类别 + 依赖关系」的表；
2. **批量预授权**：右侧「任务与权限预检」面板把表渲染出来，用户点一下（或「全部授权」）即可授权整类权限；
3. **即时放行 + 超时让路**：之后同类审批由插件直接答复 `allowed-once`，用户无感；未覆盖的审批等 `approvalTimeoutSeconds` 秒后自动让路，模型收到「先去干别的」的提示，迟到的点击仍会转成常驻授权并把模型唤醒。

**权限只能由用户授予。** 模型没有任何工具能给自己加权限：面板是唯一的授权入口，且它走的是带登录凭据的宿主通道。

## 效果

![任务与权限预检面板](assets/screenshot-1.png)

| 没有插件 | 有插件 |
| --- | --- |
| 每个需要审批的调用各弹一次卡，用户不在电脑前就整轮卡死 | 开工时在面板里点 1–3 下，之后一路无阻 |
| 卡住时模型只能空等 | 超时后模型自动切到不受该权限阻塞的子任务 |
| 用户 5 分钟后才点「允许」 | 那一次点击仍会被记成常驻授权，并主动唤醒模型继续 |

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle "C:\path\to\dsh-approval-preflight"
```

或把本目录放进 profile 的 bundle 列表。包里已带 `cordis.patch.yml`，安装后自动插入一行 Host 插件与一个 Client 模块。

> 首次安装/替换同一个包后如未生效，重启一次 DSH：Host 侧插件模块按 ESM 缓存加载，替换已加载过的包需要新的模块世代。

## 使用

不需要手动做任何事。当任务会涉及多次写文件、执行命令或联网时，模型会在开工前登记计划表，面板自动弹开：

- **权限类别**行：`待授权` 点「授权」，`已授权` 可「撤销」，`等待中` 表示有审批超时挂起；
- **子任务**行：显示状态、依赖是否就绪、需要哪些权限；
- 底部「全部授权」一次性授权本计划需要的全部类别；
- `Esc` 关闭面板，输入框上方的「🛡 预检」条随时可以重新打开。

模型可用工具：`preflight_plan`（登记计划）、`preflight_status`（查看进度与可开工项）、`preflight_task`（更新子任务状态）。任务收尾时 `preflight_plan` 传空 `tasks` 数组即可清除计划表，面板随之收起。

## 权限类别

| 类别 | 覆盖 | 说明 |
| --- | --- | --- |
| `fs-write` | `write` / `edit` | 可能包含工作区外路径 |
| `exec` | `pwsh` / `bash` / `terminal_*` | 执行命令 |
| `network` | `web_fetch` / `web_search` | 联网访问 |
| `danger` | `sandbox_permissions=danger-full-access` | 范围最大，默认包含在可授权列表里但必须由用户显式点击 |

审批请求只携带工具名与调用 id，插件用 `tools/pre-execute` 记下的 `callId → 参数` 关联来分类；**分类不出来的一律交回原生审批卡**，绝不猜测放行。

## 配置

`cordis.patch.yml` 里的行配置（都可在 profile patch 中覆盖）：

```yaml
- id: approval-preflight
  config:
    approvalTimeoutSeconds: 90   # 0 = 关闭超时让路，退回阻塞行为
    enabledClasses: [fs-write, exec, network, danger]
    maxTasks: 40                 # 计划表行数上限
    wakeOnGrant: true            # 授权后是否主动唤醒模型
```

## 状态与断点续跑

没有独立数据库。计划表来自会话日志里的 `preflight_plan` / `preflight_task` 工具调用参数，授权来自注入的用户消息标记 `[[preflight:grant:...]]`（同样是持久事件）。所以会话恢复后，插件从日志重建计划与授权，不需要用户重新授权。

## 验证

```bash
node scripts/selftest.mjs        # 27 项：纯决策逻辑
node scripts/contract-test.mjs   # 31 项：用假 Cordis 上下文加载真实 index.js
node scripts/client-test.mjs     # 22 项：在假浏览器里加载真实 client.js
```

- **selftest**：权限分类、计划校验与就绪度、已授权请求不转交原生卡、超时让路（`rejected` + 挂起 + 引导注入）、迟到点击转常驻授权并唤醒、从会话日志重建计划与授权（含旧格式标记）、空任务列表清除计划。
- **contract-test**：`inject` 声明完整性（复刻 Cordis 的 `cannot get property "x" without inject` 规则）、三个工具注册与输出定义、提示词段落、`approval/request` 的 `prepend` 注册与即时放行、面板路由的请求/响应信封、无 web 服务时的降级。
- **client-test**：模块工厂 id、两个槽位注册、无会话/关闭态返回 `null`、有数据后的状态条文案、自动弹面板、关闭与重开、授权按钮真的打到 Host 通道。

真机链路已验证：右侧面板渲染、Host↔Client 通道、面板授权写入、授权通知注入、模型唤醒。

## 已知限制

- **不接管原生审批卡**：未授权的请求仍显示原生卡片；本插件只拦截「已授权类别」并在超时后让路。这是为了不破坏 Harness 自带的审批 UI。
- **分类依赖工具名与参数**：第三方 MCP 工具无法归类，永远走原生审批。
- **超时让路不等于后台执行**：工具调用本身是同步的，插件只能让模型不再被它卡住，并在授权到达后由模型重试；真正的后台补执行需要 `tools.execute` 再派发，属实验性能力，未包含在 1.0 中。
- **Client 侧自建样式**：按 Harness 规范只用 `--dsw-alias-*` 主题变量，未引入宿主 Client 包。

## 目录

```
index.js              Host 入口：inject、工具注册、审批拦截、通道安装
client.js             浏览器侧：输入框上方的状态条 + shell.overlay 里的侧面板
lib/classes.js        权限类别与工具分类
lib/plan.js           计划表校验、就绪度、渲染
lib/state.js          会话状态机：授权账本、超时让路、日志重建
lib/channel.js        面板通道：自有 webServer 前缀路由 + 认证栅栏
lib/tools.js          三个模型侧工具
lib/rpc.js            通道端点（status / grant / revoke）
lib/prompt.js         系统提示词中的工作流规则
lib/config.js         配置归一化
lib/messages.js       消息构造与授权标记解析
scripts/selftest.mjs  纯逻辑自测
docs/design.md        设计说明与平台机制记录
```

## License

MIT
