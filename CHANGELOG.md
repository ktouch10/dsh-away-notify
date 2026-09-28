# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/ktouch10/dsh-away-notify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ktouch10/dsh-away-notify/releases/tag/v0.1.0
