# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.3]

### Added

- **诊断日志补上「排定 / 挂起 / 撤销」** —— 之前只记投递。真做验收时遇到「两小时一封没发」，
  光看日志分不清是「压根没排定」「被撤销了」还是「排定后被挂起」，而三种原因的修法完全不同
- **配置摘要标出环境变量取到没有**：`smtpPass=env:NAME(已取到)` / `(未取到!)`。
  「配了哪个变量名」和「那个变量里有没有值」是两件事，**后者才是会炸的** —— 实测撞过
  「脚本显示已读到密码，插件却报未取到」这种自相矛盾。只写是与否，永远不写值

### Fixed

- **会话标签取错位置**：`String(id).slice(0, 8)` 在 `session-86052c05-…` 上只会得到
  `session-` —— 看着像有标签，其实区分不了任何会话。改成先剥前缀
- **`verify-smtp.mjs` 自己读到了密码却没告诉插件去哪儿取**：`normalizeConfig` 会把 `smtpPassEnv`
  填成默认值 `DSH_SMTP_PASSWORD`，而脚本用的是 `DSH_SMTP_PASS`，于是「已从环境变量读到（16 字符）」
  和「未取到 SMTP 密码」同时打印。显式传 `smtpPassEnv` 顺带把生产推荐的路径也验了
- 卫生扫描误报：`pass = '…'` 的形状被判成硬编码凭据（规则宁可错杀），改变量名即可

### 已验证（真实环境，非模拟）

- **SMTP 真投递**：对 `smtp.qq.com:465` 用真实账号 + 授权码走完
  `220 → 250 EHLO → 235 AUTH PLAIN → 250 MAIL/RCPT → 354 → 250 queued → 221`，邮件真的进了收件箱
- **界面验收四项**：①人回来了就撤销 ②静默 N 分钟发信（实测 2 分 04 秒）③总开关关/开
  ④面板改配置实时生效（`dwellMinutes` 5→2 立刻按 2 分钟触发）
- **DSH nightly 升级后字段级复核**：`turn/end.data.reason` 仍是对象、`usage` 键名未变、
  `source.kind` 仍有 `user`/`skill-catalog`、会话日志仍是 `session.v4.jsonl.zstd`

## [0.1.2]

### Added

- **带表单的面板** —— 界面左下角一个小小的「提醒」按钮，点开是分四组（基本 / 触发规则 /
  投递 / SMTP）的 22 个字段，保存写入覆盖层并**实时生效**。按钮**可拖动**且记住位置
  （悬浮难免挡东西）；配色**不依赖宿主的 CSS 变量**，按实际背景亮度自动选深浅 ——
  第一版用了 `var(--dsw-alias-background-primary, …)`，结果黑底黑字看不清。
  之前那张卡片只有「完整名称 / 配置状态 / 运行状态」三行，**没有配置项** —— 拿装了半年的
  `qq-mode-console` 做对照也一样（它的注释写着「没有 browser/client 半，不会自动生成
  WebUI 设置卡片」）。

  面板走的是**宿主端自己服务**的路子（`ctx.webServer.register` + `webserver/index-inject`
  注入行），不是原生设置页。三个关键点，全部来自 `dsh-whale-widget` 踩过的坑：

  1. **注入行的注册必须是 `apply()` 的第一件事** —— 桌面端那张表由宿主在启动时**一次性收集**
     （`collectIndexInjections()` → IPC → 渲染层），**没有刷新路径**，晚了就永远进不了表。
  2. **只能用内联 `kind: 'script'` 行，绝不能用 `script-src`**：页面侧解释器对两者处理不对称 ——
     内联行是 `createElement + textContent + append`，没有 await，不可能"加载失败"；而
     `script-src` 走 `await loadScript(src)`，失败即 reject，那个 reject 会 reject 掉
     `__DSH_BOOT_READY__` ⇒ **整个应用起不来**。
  3. **内联那段代码自己建 `<script src>` 并吞掉 `onerror`** —— 路由在就正常加载，路由不在就静默失败。

  配套：
  - **覆盖层配置**（`~/.dsh/dsh-away-notify/config.json`）：白名单 + 类型收敛（布尔/数字/枚举）
    + 原子写入（临时文件 + rename）。优先级 `schema 默认值 < cordis.patch.yml < 覆盖层`，
    面板里被覆盖过的字段有边框提示，可一键「清除全部覆盖」。
  - **信任栅栏**：只允许回环 Host（`127.0.0.0/8` 逐段校验）、`Origin` 必须与 Host 同源、
    `Sec-Fetch-Site: cross-site` 一律拒 —— 防 DNS 重绑定与跨站写入。
  - **密码不回显**：`smtpPass` 永不下发到浏览器。
  - 只有「静默时长 / 最晚推迟」改动需要重建调度器（那两个值是构造时捕获的）；
    其余字段都是使用时读取，原地生效。`tickSeconds` 只重启定时器。
- **`scripts/verify-smtp.mjs`（`pnpm run verify:smtp`）**：拿插件**自己的** SMTP 代码
  去连真实邮件服务器。`--probe` 只做连接 + TLS + EHLO（不需要账号、不发信、不送凭据），
  真发模式凭据只从环境变量读取、输出全程脱敏。失败时按错误类型给排查提示
- `sendSmtp` 新增 `probeOnly` 能力（探测与真发信走**同一段**连接/TLS/EHLO 代码路径）

### 走过的弯路：原生设置页（`dsh.client`）试过，会让 DSH 起不来

现在面板的形态是被这次失败"逼"出来的，过程值得留着：

- 加上 `dsh.client` 声明之后 **DSH 打不开**。当时唯一的抓手是插件自己的诊断日志 ——
  它显示**两次失败的启动里宿主半边都正常 apply 了**（`session/event 订阅成功`、`已启用`），
  所以炸的是启动**后半段的客户端插件清单**，而那正是当时唯一新增的启动路径改动。
- DSH 文档对这个失败模式有专门警告：`clientModules` 的激活扫描是**同步**的，已加载条目里
  只要有一个**声明写坏**或 **bundle 找不到**，就会聚合成一次响亮的抛错（**FAILED fiber**）。
- 真正的原因：**DSH 的客户端 bundle 是"用 CJS 模块系统包装的已构建产物"**，不是 ESM 源码。
  从它自己的 `lib/client.js` 能看出形态（`(function (module, exports, require) { …
  exports.apply = apply; exports.inject = inject; return module.exports })`，还有
  `require.async("./client.pdf.js")` 这类分块加载）。把带 `import` 的源码交给它 = 往函数体里
  塞 `import` → 语法错误 → 抛错。**要走这条路，必须先引入构建步骤。**
- 另外桌面端连 `tapIndex` 都用不上（桌面壳的 `index.html` 从安装包静态 dist 直出，
  永远不经过宿主的 `renderIndex()`）。

所以撤掉声明、删掉那份不可用的客户端半边，改成宿主端面板 —— **出错最多是面板不显示，
不可能让 DSH 起不来**。原来的「减速带」断言（`package.json` 不该有 `dsh.client`）也一并去掉了，
因为现在根本没有那个声明。

### 已用真实服务器验证

```
smtp.qq.com:465
  220 newxmesmtplogicsvrszc43-0.qq.com XMail Esmtp QQ Mail Server.
  250-AUTH LOGIN PLAIN XOAUTH XOAUTH2 ...
  TLS ✓ 已加密    AUTH ✓ 服务器要求认证    282 ms
```

这补上了一个真实空白：仓库里的 SMTP 测试对着的是自写的**明文**假服务器，
隐式 TLS（465）这条分支从没被真实验证过。

### 安全 / 工程

- 客户端半边（`src/client.mjs`）暂时**不挂出**：DSH 要的是用 CJS 模块系统包装的**已构建产物**
  （见下面「已撤回」），直接交带 ESM `import` 的源码会让 DSH 起不来
- 字段表在客户端内联了一份（因为那个产物必须自包含），`test/client.test.mjs` 钉住它和宿主
  schema 不漂移，并断言「除了 react 没有任何 import」
- 同一支用例里有一条**刻意反向**的断言：`package.json` 目前**不应**声明 `dsh.client` ——
  这是道减速带，防止没搞清 bundle 形态就重新打开

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

[Unreleased]: https://github.com/ktouch10/dsh-away-notify/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/ktouch10/dsh-away-notify/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ktouch10/dsh-away-notify/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ktouch10/dsh-away-notify/releases/tag/v0.1.0
