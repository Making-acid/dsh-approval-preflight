# 加载与真机验证

离线测试（`npm test`）证明的是逻辑与装配；真正“这个插件在你机器上活着”要重启一次确认。
这份清单把「怎么重启、怎么确认加载的是新版、怎么跑一遍真实链路、出问题先看哪里」写清楚。

---

## 0. 为什么必须重启

Host 半是 ESM 模块，Node 进程按模块 URL 缓存：替换包内容后，**已经在跑的进程不会重新加载**。
Client 半（面板）会走 HMR / 刷新，所以「面板是新的、Host 还是旧的」这种不一致是可能的，
判断依据只看日志里的版本行：

```text
~/.dsh/logs/approval-preflight.log
2026-10-29T…Z apply: start (v2.1.0)
2026-10-29T…Z apply: wired (v2.1.0, channel=/dsh-approval-preflight)
2026-10-29T…Z channel: prefix route installed on /dsh-approval-preflight
2026-10-29T…Z apply: channel scope ready (/dsh-approval-preflight)
```

profile 里装的是 `link:` 依赖，指向本仓库目录，**不需要重新安装**，重启即生效。

## 1. 重启

完全退出 DSH NEXT（含托盘图标；只关窗口可能只是隐藏），再重新打开。
不需要清缓存、不需要重装。旧 v1 的类别授权不会被迁移：面板显示「还没有计算图」是正常的。

## 2. 三个「已加载」信号

一条命令先看结论：

```bash
npm run verify:loaded
# ✓ 正在跑的就是 v2.1.0，面板路由已在 … 装好。
# ✗ 日志里的激活行没有版本号：这是 2.0.1 之前的构建，Host 还没重启。
```

它读 `<DSH_HOME>/logs/approval-preflight.log`（默认 `~/.dsh`），比较最后一次激活版本与 `package.json`。

| 位置 | 期望 |
| --- | --- |
| Host 日志 | 最后几行是 `apply: start (v2.1.0)` → `apply: wired (v2.1.0, channel=…)` → `channel: prefix route installed` |
| 面板底部右下角 | 灰色小字 `v2.1.0`（来自 `status` 端点的 `plugin.version`） |
| 模型工具 `preflight_status` | 输出末尾：`插件已加载：dsh-approval-preflight v2.1.0` |

三者任一缺失，就说明对应一半没更新：日志缺失 = Host 没重启；面板没版本 = 浏览器缓存旧 bundle（Ctrl+R 硬刷新）；
工具不存在 = Host 仍是 v1 或插件未启用。

## 3. 端到端场景（约 2 分钟）

开一个新会话（任意目录），对模型说：

> 这是权限预检测试。请在 `工作区/.preflight-demo/` 下新建 `hello.txt` 写入一行字，然后读回来确认内容。

期望链路：

1. 模型先调 `preflight_graph`，登记两个节点：`N1` 写入 `hello.txt`（effect `write`，影响 `fs-write`）、`N2` 读取（effect `read`，不需要批准）。
2. 输入框上方出现预检小条（`1 待批准`），右侧面板自动打开；`N1` 卡片上能看到「写入 → 工作区/.preflight-demo/hello.txt」这类语义描述和影响标签。
3. 点 `批准`：模型被唤醒（`wakeOnGrant: true`），调 `preflight_node_start{id:"N1"}`。
4. 真正写文件时**不再弹原生审批卡**——拦截器在节点窗口内、影响类型匹配时直接返回 `allowed-once`。
5. `preflight_node_end{success:true}`：节点变「已完成」，这次批准被消耗（再写一次会重新要批准）。
6. 卡片上点「查看实际执行 (n)」：能看到节点窗口内实际跑过的 `write` / `read` 与结果。

可以再做一个反例：让模型在 `N2` 里跑一条 `pwsh` 命令。`N2` 没有申报 `exec`，
所以这条命令仍会弹原生卡（插件不接管），这就是「未申报操作走原生卡」的边界。

## 3b. 自动切换场景（约 2 分钟）

目的：验证「审批长时间没人点 → 自动挂起当前节点 → 切到不依赖它的独立分支」。

前置：把 `approvalTimeoutSeconds` 临时调小（面板配置或 `cordis.patch.yml`，默认 90 秒；测试用 15 秒就够），重启生效。

对模型说：

> 计算图测试：先建一个配置文件写入（主线 N1），再写一段说明文档（独立分支 N2），最后发布（N3，依赖 N1）。
> 在 N1 里尝试用需要审批的命令推送一次。

期望：

1. `preflight_graph` 登记三个节点，`N3.dependsOn = ["N1"]`；`N1`、`N2` 提交后由你批准。
2. 模型 `preflight_node_start{id:"N1"}`，然后那个需要审批的调用弹原生卡；**不要去点**。
3. 等过 `approvalTimeoutSeconds`：该调用快速失败；小条显示 `1 项已挂起`；面板里 `N1` 变「已挂起」并写明原因，`N3` 显示「等前置 N1（已挂起）」，`N2` 仍是「已批准」。
4. 模型下一条消息应当直接 `preflight_node_start{id:"N2"}`——它没有重试刚才那个调用。
5. `N2` 做完后，模型可以 `preflight_node_start{id:"N1"}` 继续（批准还在，不会再要你批准）。
6. 面板底部的「不依赖它的可做节点：N2」和图上分层（`N1`/`N2` 同一列，`N3` 在下一列）应当对得上。

反例：如果所有剩余节点都依赖 `N1`，通知会明确说「没有可切换的独立分支」，模型不应乱试。

## 4. 排错顺序

| 现象 | 先查 |
| --- | --- |
| 小条和面板都不出现 | 日志有无 `apply: wired`；`dsh.client.platform` 是否为 `web`；Ctrl+R 刷新页面 |
| 面板打开但一直「正在读取预检状态…」 | 前端 `status` 请求失败：看日志 `channel: …` 行；确认 Host 日志没有 `channel: install failed` |
| 面板没有版本号 | 浏览器还是旧 client bundle：Ctrl+R；再确认日志版本行 |
| 面板显示「这个会话还没有计算图」 | 正常——该会话还没登记图，不是故障 |
| 批准后执行时仍弹原生卡 | ① 该调用影响类型不在节点 `impacts` 里（写文件=`fs-write`、命令=`exec`、联网=`network`）；② 节点还没 `preflight_node_start`；③ 调用没被归类（MCP/`terminal_*` 一律不放行）；④ 审批策略是 `never` |
| `preflight_status` 工具不存在 | Host 半还是 v1：确认真的重启了应用进程 |
| 批准点了没反应 | 看小条/面板是否会每 2.5s 刷新；看日志 `面板批准节点：…` |

日志在 `~/.dsh/logs/approval-preflight.log`，只记事件与错误，不记工具参数内容。

## 5. 离线回归

```bash
npm test                          # 全部
node scripts/selftest.mjs        # 79 项：语义/图/依赖/状态机/挂起切换/回放/版本一致性
node scripts/contract-test.mjs   # 53 项：真实 index.js 在假 Cordis 上下文里的装配、输出 schema 与通道往返
node scripts/client-test.mjs     # 39 项：真实 client.js 在假浏览器里的渲染与交互（含分层图、挂起态）
```

改完代码先跑这三套，再重启做一次第 2、3、3b 节的确认。
