# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.1]

### Fixed

- **README 里有个重复的空 `## 配置` 标题** —— 一次编辑留下的，已经随 0.1.0 发出去了。
  npm 包不能重发同一个版本，所以只能发新版修（这正是下面那条守卫的由来）
- README 的用例数、目录清单与实际同步

### Added

- **README 结构守卫**（`test/docs.test.mjs`）：检查重复标题、内部锚点是否能落到标题上、
  相对链接指向的文件是否存在。README 是仓库门面也是 npm 页面内容，而 npm 包**不能重发同一版本** ——
  文档的错要发新版才能修，所以值得在 CI 里挡住

## [0.1.0]

首个版本。核心是一句话：**只在「活真的干完了，而且你 N 分钟没回来」时才提醒。**

### Added

- **静默延迟状态机**（`src/dwell.mjs`）：`turn/end` 之后先等 `dwellMinutes`，期间出现「用户回来了」的信号就撤销；纯函数式，不持有定时器也不读时钟，可用虚拟时钟逐条断言
- **burst 合并**：同一会话反复续跑时合并成一条提醒，而不是每轮一封
- **busy 门**：`turn/start` 会挂起待发提醒（后台任务唤醒 agent 时不该发「任务已结束」），但不撤销
- **`maxDwellMinutes` 上限**：从首个 `turn/end` 起算，防止提醒被系统行为无限推迟
- **结果摘要**：会话名、结束原因、轮数、工具调用与失败数、token 消耗、最后一段回复
- **抑制规则**：空转回合（无工具调用也无回复）默认不提醒；`minToolCalls` 可设阈值
- **投递通道**：`outbox`（落盘 `.eml` + `.txt`，零配置可验证）与 `smtp`（自研极简客户端，只用 `node:net` / `node:tls`，隐式 TLS 与 STARTTLS）
- **设置卡片（面板）**：22 个字段全部可写，`applies: live` 改完立即生效；密码字段标 `role('secret')`，不回传浏览器
- **零运行时依赖**；`@deepseek-ai/schemastery` 是可选 peer，拿不到时降级为「无卡片」而不是加载失败
- 三个开发脚本：`demo.mjs`（端到端演示）、`print-settings.mjs`（不重启 DSH 预览面板）、`inspect-session.mjs`（从会话日志读出真实事件契约）
- 三个守卫：`check-hygiene.mjs`（敏感信息）、`check-tarball.mjs`（真实打包后核对内容）、`check.mjs`（统一入口，本地与 CI 同一条命令）
- GitHub Actions：`ci.yml`（Node 22/24 矩阵 + 零依赖冒烟）、`release.yml`（tag 触发，OIDC Trusted Publishing）

### 开发期间发现并修掉的契约坑

这些都不是猜的，是用本机真实会话日志（555 条记录，DSH 0.1.7-rc.2）核对出来的：

- **`turn/end.data.reason` 是对象不是字符串**（`{ kind: 'completed' }`）。`String()` 会得到 `"[object Object]"`，导致每封邮件「结束原因」都错，而且被判成非正常完成
- **`tool/result` 的失败标记在 `data.message.isError`**，不在顶层。只查顶层会漏掉一部分失败
- **DSH 会注入 `role` 同样是 `"user"` 的非人类消息**（`runtime-context` / `skill-catalog` / `agent-message` / `subagent-settled`）。按 `role === 'user'` 判断「人回来了」的话，这些每回合都会到，待发提醒会被系统行为一次次撤销 —— 插件看起来正常但永远不发信。只认 `source.kind === 'user'`
- **schemastery 的 volatile 字段是引用对象 `{ get() }`**，`JSON.stringify` 会静默丢掉它们的值（键还在、值全变 `{}`），`structuredClone` 直接抛错

### 真实 DSH 端到端验证时发现并修掉的问题

装进 `desktop` profile 真跑之后才暴露出来的，离线测试永远测不到：

- **插件在真实 DSH 里「启动失败」**：cordis 的 ctx 是 Proxy，**访问一个没有 inject 的服务会直接抛**
  `cannot get property "x" without inject` —— 可选链 `ctx?.x` 挡不住（抛的是属性读取这个动作本身）。
  `apply()` 开头就裸读 `ctx.settings` / `ctx.logger`，且都在 try/catch 外，所以启动即炸
- **邮件里的 token 数字看不懂**：`totalTokens` **包含缓存命中**（实测 `19255 = 17319 + 1536 + 400`），
  而渲染时只列了输入/输出。现在把「缓存读」也列出来
- **会话标题回落成 session id**：`session/title` 事件在插件加载**之前**就产生了，插件收不到历史事件。
  改为优先用 DSH 的 `sessionTitle` 服务（`svc.get(session)` 折叠会话日志，含启动前的标题）

### 新增

- **诊断日志**：DSH 不保存插件主机端的输出，所以插件自己写 `~/.dsh/dsh-away-notify/status.log`
  （启动结果、配置摘要**脱敏**、注册与订阅结果、每次决策；256KB 上限；写失败不影响功能）
- **排查章节**（README「为什么没收到提醒」）

[Unreleased]: https://github.com/ktouch10/dsh-away-notify/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ktouch10/dsh-away-notify/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ktouch10/dsh-away-notify/releases/tag/v0.1.0
