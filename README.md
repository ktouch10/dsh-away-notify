# dsh-away-notify

**只在「活真的干完了，而且你 N 分钟没回来」时才提醒你。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件。现有通知插件都在 `turn/end` 上立刻发——你人就在屏幕前的时候，它照发。这个插件反着做：干完之后先安静等着，**你回来了就撤销，你不回来才发信**。

```
干完 → 安静等待 N 分钟 ──┬── 你回话了        → 撤销，不打扰
                        └── 一直没人            → 发一封邮件（带结果摘要）
```

静默时长 N 可配置。等待期间 agent 若被后台任务唤醒继续干，提醒会自动挂起并合并，最后只发一封。

```
任务跑完，你人不在  →  ✉️「任务已结束，5.0 分钟无人应答 · 修复登录接口超时」
任务跑完，你在旁边  →  （什么都不发）
一晚上续跑 6 轮     →  ✉️ 一封，而不是六封
```

---

## 为什么又写一个通知插件

DSH 生态里的通知插件非常多（`dsh-plugin` 关键词下有数千个包）。做这个不是因为它容易，而是因为**这一条规则没人做**：

| 现有插件的做法 | 本插件 |
|---|---|
| `turn/end` 立即发 | 先等 N 分钟 |
| 等「agent 真正 idle」才发（正确性门，时长不可配） | 等你回来才不发（交互门，**时长可配**） |
| 2 秒防误报窗口，写死在源码里 | 分钟级静默窗口，配置项 |
| 每轮发一条 | 同一会话的连续回合合并成一封 |

所以它**不替代**已有的通知插件，而是补一个它们都没覆盖的语义：*「你不在的时候才值得吵你」*。

## 安装

前置：`dsh`（CLI 来自 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)）。

```sh
dsh plugin --profile <你的 profile> add dsh-away-notify
```

> ⚠️ profile 名不一定是 `web`。桌面端（`DeepSeek Harness.exe`）常用的名字是 `desktop`，
> 看一眼 `~/.dsh/profiles/` 下有哪些目录即可确认。装完**重启** dsh 生效。

本包**零运行时依赖**，所以 `link:` 安装也不需要补任何 peer 链接：

```sh
dsh plugin --profile desktop add link:/path/to/dsh-away-notify
```

卸载：`dsh plugin --profile <profile> remove dsh-away-notify`

## 面板（配置界面）

配置有三条路，写的都是**同一批扁平键**：

| 来源 | 位置 | 说明 |
|---|---|---|
| **界面面板** | 界面**左下角**一个小小的「提醒」按钮 | 点开是一张分四组的表单，保存即写入覆盖层 |
| `cordis.patch.yml` | 插件包内 | 组合层 |
| 覆盖层 JSON | `~/.dsh/dsh-away-notify/config.json` | 面板保存的那份，**优先级最高** |

优先级：`schema 默认值` < `cordis.patch.yml` < `覆盖层`。面板里每个被覆盖过的字段会有边框提示，
「清除全部覆盖」可以一键回到 YAML 的值。

改完**立刻生效**（包括总开关：在面板里关掉就停止监听，打开就恢复），只有两个例外：
改「静默时长 / 最晚推迟」会重建内部状态机（**待发提醒会重新计时**），改「轮询间隔」只重启定时器。

> 覆盖层是**白名单**的：只认 schema 里那 22 个键，并按类型收敛（布尔/数字/枚举），
> 写入是**原子**的（临时文件 + rename）。请求里塞 `__proto__` 或未知键都会被拒。

### 为什么面板是宿主端自己服务的，而不是原生设置页

原生设置页（`settings.plugins.tab` + `dsh.client`）是更"正统"的做法，但本插件**试过并且失败了** ——
加上 `dsh.client` 声明之后 **DSH 直接起不来**。这段经历值得留着：

- **只有宿主半边的插件不会有配置表单。** 装进真实 DSH 后卡片只显示「完整名称 / 配置状态 /
  运行状态」三行；拿装了半年的 `qq-mode-console` 做对照也一样（它的注释写着
  「没有 browser/client 半，不会自动生成 WebUI 设置卡片」）。
- **DSH 的客户端 bundle 是「用 CJS 模块系统包装的已构建产物」**，不是 ESM 源码。
  从它自己的 `lib/client.js` 能看出形态：
  `(function (module, exports, require) { … exports.apply = apply; exports.inject = inject; return module.exports })`，
  还有 `require.async("./client.pdf.js")` 这种分块加载。把带 `import` 的源码交给它 = 往函数体里塞
  `import` → 语法错误 → 抛错。而 DSH 文档写着：客户端插件扫描是**同步**的，任何一个条目
  **声明写坏**或 **bundle 找不到**都会聚合成一次响亮的抛错（**FAILED fiber**）⇒ **整个应用起不来**。
  所以要走这条路，必须先引入**构建步骤**。
- **桌面端连 `tapIndex` 都用不上**：桌面壳的 `index.html` 从安装包静态 dist 直出，永远不经过宿主的
  `renderIndex()`。

所以改用**宿主端自己服务面板** —— 全部是宿主代码，出错最多是面板不显示，**不可能让 DSH 起不来**。

### 面板怎么进到界面里（桌面端）

桌面端唯一的注入通道是 **`webserver/index-inject`** 事件推的结构化行，宿主启动时
`collectIndexInjections()` **收集一次**后经 IPC 交给渲染层，**没有任何刷新路径**。三个要点：

1. **注册必须是 `apply()` 的第一件事** —— 晚了就永远进不了那张表（`dsh-whale-widget` 的 #152/#153 就是这个竞态）。
2. **只能用内联 `kind: 'script'` 行，绝不能用 `script-src`**：页面侧解释器对两者处理**不对称** ——
   内联行是 `createElement + textContent + append`，没有 await，不可能"加载失败"；而 `script-src` 走
   `await loadScript(src)`，失败即 reject，那个 reject 会 reject 掉 `__DSH_BOOT_READY__` ⇒ **应用起不来**。
3. **内联那段代码自己建 `<script src>` 并吞掉 `onerror`** —— 路由在就正常加载，路由不在就静默失败。

这三条都是从 `dsh-whale-widget` 的实测注释里学来的（它为此踩过 issue #152/#153/#154）。本插件的
`test/panel.test.mjs` 把每条都钉成了用例。

### 安全

写接口自带**信任栅栏**：只允许回环 Host（`localhost` / `127.0.0.0/8` 逐段校验 / `::1`）、
带 `Origin` 时必须与 Host 同源、`Sec-Fetch-Site: cross-site` 一律拒 —— 防 DNS 重绑定与跨站写入。

**密码不回显**：`smtpPass` 永远不下发到浏览器（面板那一栏是「留空即不修改」），
这与 schema 上 `role('secret')` 的意图一致。

### 命名空间要能被写入的三个条件

即使现在走宿主端面板，命名空间那三个条件仍然成立（它决定的是**程序化读写**能不能生效）。
不重启 DSH 也能先看清命名空间长什么样：

```sh
node scripts/print-settings.mjs
```

| 条件 | 本插件的做法 | 验证情况 |
|---|---|---|
| `cordis.patch.yml` 里 entry 的 `id` **恰好等于**命名空间名 | `id: away-notify`（`name` 才是包名） | 卡片显示 `include:away-notify` ✓ |
| 插件模块导出 `Config` | `src/settings.mjs` 构造，`src/index.mjs` 再导出 | 卡片「配置状态：已启用」= schema 校验通过 ✓ |
| `Config` 里至少有一个 volatile 字段 | 22 个字段**全部** volatile | `print-settings.mjs` 审计 + 用例断言 ✓ |

第二条里的细节值得记一下：**只有 volatile 字段会出现在表单里**（DSH 用 `volatileForm(schema)` 过滤），漏标就等于该字段消失。

密码那一栏标了 `role('secret')`，主机端不会把值回传给浏览器。

> 拿不到 `@deepseek-ai/schemastery` 时（`link:` 装法的常见坑）会**降级**成没有卡片，配置仍然从 `cordis.patch.yml` 读 —— 不会因为少一个 peer 就让整个插件加载失败。

## 配置

面板和 `cordis.patch.yml` 写的是**同一批扁平键**，所以不存在「两层配置谁覆盖谁」的歧义 —— 合并顺序由 DSH 决定（schema 默认 → composition base → 用户设置层）。

改 profile 的 `cordis.patch.yml`（或 install 时 `--patch` 覆盖）：

```yaml
- id: away-notify            # ← 必须与设置命名空间同名
  name: dsh-away-notify
  config:
    dwellMinutes: 5          # ← 核心旋钮：安静多少分钟才提醒
    maxDwellMinutes: 30      # 合并批次最晚推迟到「首个回合结束 + 这么久」
    tickSeconds: 5

    cancelOnUserMessage: true
    cancelOnTurnStart: false

    minToolCalls: 0
    suppressEmptyTurns: true

    transport: outbox        # outbox = 落盘（默认）；smtp = 真发信
    outboxDir: ''            # 空 = ~/.dsh/dsh-away-notify/outbox
    subjectPrefix: '[DSH]'
    language: zh
    excerptChars: 400

    smtpHost: smtp.qq.com
    smtpPort: 465
    smtpSecure: true
    smtpUser: you@qq.com
    smtpPass: ''                       # 留空，改用环境变量
    smtpPassEnv: DSH_SMTP_PASSWORD
    smtpFrom: ''                       # 空 = 用 smtpUser
    smtpTo: 'you@qq.com'               # 多个用逗号分隔；空 = 发给自己
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dwellMinutes` | `5` | **核心。** 回合结束后安静这么久仍无用户消息才提醒。设 `0` 就退化成「干完就发」，失去本插件的意义 |
| `maxDwellMinutes` | `30` | 从**首个** `turn/end` 起算的上限。防止 agent 反复自我唤醒导致提醒被无限推迟 |
| `tickSeconds` | `5` | 内部轮询间隔，只决定「多久检查一次到没到点」 |
| `cancelOnUserMessage` | `true` | 真正的用户消息会撤销待发提醒 |
| `cancelOnTurnStart` | `false` | 是否也把「开新回合」当作人在的信号（**默认关闭**，见下） |
| `minToolCalls` | `0` | 低于这个工具调用次数的批次静默。`0` = 关闭 |
| `suppressEmptyTurns` | `true` | 既无工具调用又无回复文本的空回合不提醒 |
| `transport` | `outbox` | `outbox` 把邮件落盘（零配置可验证）；`smtp` 真发 |
| `outboxDir` | `''` | 落盘目录，空 = `~/.dsh/dsh-away-notify/outbox` |
| `subjectPrefix` | `[DSH]` | 邮件主题前缀 |
| `language` | `zh` | 邮件语言（`zh` / `en`） |
| `excerptChars` | `400` | 正文里「最后一段回复」的最大字符数 |
| `allowInsecureAuth` | `false` | 仅限本地测试服务器：允许在明文连接上 AUTH |
| `smtpHost` / `smtpPort` / `smtpSecure` | `''` / `465` / `true` | SMTP 服务器、端口、是否隐式 TLS |
| `smtpUser` / `smtpPass` / `smtpPassEnv` | `''` / `''` / `DSH_SMTP_PASSWORD` | 账号、密码（建议留空走环境变量）、变量名 |
| `smtpFrom` / `smtpTo` | `''` / `''` | 发件人（空 = 用 `smtpUser`）、收件人（逗号分隔，空 = 发给自己） |

## 判定规则

**会发**：某会话最后一个回合结束，之后 `dwellMinutes` 内没有出现「用户回来了」的信号。

**不发**：
- 等待期间用户发了消息（`user/message` 且 `source.kind === 'user'`）→ **撤销**
- 等待期间该会话开了新回合（后台任务唤醒、目标续跑）→ **挂起**，回合结束后重新计时并合并
- 整个批次没有任何工具调用也没有回复文本，且 `suppressEmptyTurns` 开启
- 工具调用次数低于 `minToolCalls`

**为什么 `cancelOnTurnStart` 默认关闭**：`turn/start` 不是可靠的「人在」信号。目标续跑、后台任务完成唤醒 agent、subagent 回传——这些都会开新回合，而你根本不在场。把它当成人回来了，提醒就会被系统行为无声地撤销掉。真正的信号只有 `user/message` 的 `source.kind === 'user'`。

**为什么需要 `maxDwellMinutes`**：如果每 4 分钟就自动续一轮，而 `dwellMinutes` 是 5，那么「安静满 5 分钟」永远不成立，提醒就永远不发了。上限把它钉在首个回合结束之后的某个时刻。

## 邮件内容

```
Subject: [DSH] 任务已结束，5.0 分钟无人应答 · 修复登录接口超时

会话：修复登录接口超时
会话 ID：s-demo
结束原因：completed
规模：3 轮 · 3 次工具调用
消耗：61,014 tokens（输入 1,470 / 缓存读 58,461 / 输出 1,083）
静默时长：5.0 分钟（自最后一次回合结束起）
整批跨度：21.8 分钟
首个回合结束：2026-09-28 02:01:10Z
发出提醒：2026-09-28 02:23:00Z
用到的工具：bash
模型：deepseek-flash

最后一段回复：
三步都跑完了，最终结果是：测试全绿。

—— 这条提醒的规则：回合结束后安静满 5 分钟且期间你没有回过话，才会发出；你若在此期间回到会话，它会被撤销。
```

非正常结束（`error` / `aborted` / `max-tokens` …）会在「结束原因」里标出并提示建议看一眼。

## 开发

```sh
pnpm install                         # 2 个 devDependency：@deepseek-ai/schemastery、yaml
pnpm run check                       # 一条命令跑完全部检查（与 CI 完全相同）
node --test test/                    # 140 个用例
node scripts/demo.mjs                # 端到端演示（虚拟时钟，不发真实邮件）
node scripts/print-settings.mjs      # 打印设置卡片（面板）的字段表
node scripts/inspect-session.mjs     # 读出你本机 DSH 的真实事件契约
```

> 运行插件本身**不需要安装任何依赖**（零运行时依赖，Node ≥ 22 即可）。
> `pnpm install` 只是为了跑 schema 与 workflow 校验相关的用例 —— `@deepseek-ai/schemastery`
> 在真实环境里由 DSH 提供。CI 里有一个**不执行任何 install** 的 job 专门守这条承诺。
>
> 仓库里的 `pnpm-workspace.yaml` 把 `nodeLinker` 设成 `hoisted`（和 DSH profile 自己的布局一致）。
> pnpm 默认的 isolated 布局把依赖链成深层软链，实测在受限环境/Windows 上会链不全
> —— `@deepseek-ai/schemastery` 的子依赖 `@deepseek-ai/cosmokit` 会解析不到。

> 受限沙箱里 `node --test test/` 会因禁止命名管道而 `EPERM`（测试运行器给每个文件开子进程）。
> 这时改成单进程并显式列文件。注意这个 flag **改过名**：
>
> | Node | flag |
> |---|---|
> | 20.14 / **22.x** | `--experimental-test-isolation=none` |
> | 23 起（含 24） | `--test-isolation=none` |
>
> 传错名字会直接 `bad option` 并以 9 退出 —— 第一次 CI 就是这么挂的（矩阵里 Node 22 那个 job）。
> `pnpm run check` 现在会**探测**当前 Node 支持哪个，不用你记。

`scripts/demo.mjs` 用虚拟时钟驱动**真实的**接线层，几十毫秒跑完三个场景并把结果写进 `.demo-outbox/`：

- 场景 A：跑完就走人 → 到点发信
- 场景 B：2 分钟就回来 → 撤销，不发
- 场景 C：后台唤醒续跑 3 轮 → 合并成 1 封

目录：

```
src/settings.mjs       设置命名空间 + 设置卡片 schema（含 volatile / secret / 降级）
src/diag.mjs           诊断日志（启动结果、配置摘要脱敏、每次决策）
src/dwell.mjs          纯延迟状态机（不碰时钟、不碰 IO，可确定性测试）
src/summary.mjs        事件折叠 + 摘要渲染 + 抑制规则
src/transports.mjs     outbox 落盘 + 自研极简 SMTP（只用 node:net / node:tls）
src/config.mjs         volatile 解包 + 扁平配置归一化
src/index.mjs          createNotifier() 接线层 + apply() cordis 入口
src/field-spec.mjs     22 个字段的规格（标签/分组/范围）—— 面板的单一来源
src/webpanel.mjs       宿主端面板：注入行 + 路由 + 信任栅栏 + 浏览器脚本
src/panel-config.mjs   覆盖层配置（白名单 + 类型收敛 + 原子写）
test/dwell.test.mjs            状态机
test/summary.test.mjs          折叠与渲染
test/smtp.test.mjs             对着真的 TCP 假 SMTP 服务器跑完整对话
test/notifier.test.mjs         宿主接线（虚拟时钟 + outbox）
test/real-contract.test.mjs    真实契约回归（钉住从真实会话日志里核对出的形状）
test/settings.test.mjs         设置卡片（schema 审计 + volatile 语义 + 命名空间注册）
test/cordis-ctx.test.mjs       真实 cordis ctx 形状下的启动鲁棒性（Proxy 裸读会抛）
test/diag.test.mjs             诊断日志（含「日志里绝不能出现密码」的断言）
test/docs.test.mjs             README 结构守卫（重复标题 / 锚点 / 相对链接）
test/panel.test.mjs            面板（覆盖层 / 注入行 / 信任栅栏 / 路由 / 真 HTTP 冒烟）
test/field-spec.test.mjs       字段规格与 schema 不漂移
test/ci-config.test.mjs        CI / 发布配置（真解析 workflow YAML，不是正则猜）
test/fixtures/real-events.mjs  真实事件样本，逐字抄自本机会话日志
scripts/check.mjs              全量检查入口（本地与 CI 同一条命令）
scripts/check-hygiene.mjs      敏感信息扫描
scripts/check-tarball.mjs      真打一个包再解开核对内容
scripts/demo.mjs               端到端演示 / 冒烟测试
scripts/print-settings.mjs     设置卡片字段表预览
scripts/inspect-session.mjs    会话日志 → 事件契约探针
scripts/verify-smtp.mjs        拿插件**自己的** SMTP 代码去连真实邮件服务器（凭据只走环境变量）
scripts/lib/                   扫描规则与 --out 落盘工具
.github/workflows/             ci.yml（Node 22/24 矩阵 + 零依赖冒烟）、release.yml（OIDC 发布）
```

## 契约核对（DSH 升级后请重跑）

`session/event` 的字段形状没有官方 API 文档，而 DSH 还在 `0.1.x`。本插件不靠猜：

```sh
node scripts/inspect-session.mjs              # 自动找最近改动的会话，打印事件类型直方图 + 关键类型字段路径
node scripts/inspect-session.mjs --type turn/end    # 打印某类事件的原始 JSON
node scripts/inspect-session.mjs --raw 3            # 打印前 N 条原始记录
node scripts/inspect-session.mjs --out report.txt   # 落盘（Windows 终端代码页常常不是 UTF-8）
```

两个实现要点，踩过才写的：

- 会话日志是 `.jsonl.zstd`，而且是**追加写**的 —— 一个文件里通常有几百个独立 zstd 帧
  （实测某个 770 KB 的日志有 327 帧）。Node 的 `zstdDecompressSync()` 和
  `createZstdDecompress()` **都只解第一帧就停**，于是你只会读到会话头那一条，
  看起来像「这个会话没有任何事件」。探针里按帧魔数切分后逐帧解。
- 用 `--out` 让 node 直接落盘，别靠终端 —— PowerShell 的控制台代码页会把中文样本搞乱。

设计上把「决策」和「接线」分开了：`dwell.mjs` / `summary.mjs` 是纯的，所以能用虚拟时钟逐条断言；`createNotifier()` 把时钟和投递都做成可注入的，于是测试和 demo 跑的是**同一条**链路，而不是各自另写一份。

## 已验证 / 未验证

诚实划界。

**事件契约：已用本机真实会话日志核对**（555 条记录，DSH 0.1.7-rc.2）。

这一步不是走过场 —— 核对后抓到两个会让插件**看起来正常、实际全错**的 bug：

| # | 我原先以为 | 真实形状 | 后果 |
|---|---|---|---|
| 1 | `turn/end.data.reason` 是字符串 | 是**对象** `{ kind: 'completed' }` | `String()` 得到 `"[object Object]"` ⇒ 每封邮件「结束原因」都错，而且被判成非正常完成、给每封信挂上「建议看一眼」 |
| 2 | 失败标记在 `tool/result.data.isError` | 在 **`data.message.isError`**；顶层只有在抛类型化错误时才有 `error` 对象 | 失败次数少算，摘要里的「N 次失败」不可信 |

顺带确认了三件原以为对的事：助手消息的正文分片确实叫 `type: "text"`（另有 `reasoning` / `tool-call`，本会话统计 77 / 49 / 111）；`usage` 的真实键名是 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`；信封带 `seq` 与 `time`（已改用事件自己的时间，并靠 `seq` 做重连去重）。

**最关键的一条发现**：DSH 会往 `user/message` 里注入 **`role` 同样是 `"user"`** 的非人类消息，真实出现过的 `source.kind` 有 `runtime-context`、`skill-catalog`、`agent-message`、`subagent-settled`。如果按 `role === 'user'` 判断「人回来了」，这些每回合都会到 —— 待发提醒会被系统行为一次次撤销，插件**永远不发信**。所以只认 `source.kind === 'user'`，并有 `test/real-contract.test.mjs` 逐条钉住。

**面板：命名空间三个条件全部实测通过，但表单需要客户端半边。**

`@deepseek-ai/schemastery` 的 schema 能 `toJSON()`，所以命名空间的大部分性质能在没有 DSH 的情况下断言：22 个字段**全部**是 volatile（漏标就不会出现在表单里）、密码字段是 `role: 'secret'`、字段集与默认值一一对应、`cordis.patch.yml` 的 entry id 等于命名空间。

装进真实 DSH 后，卡片显示 `include:away-notify` + **配置状态：已启用** —— 说明 entry id 正确、`Config` 被读到、schema 校验通过。但那张卡片上**没有配置表单**（`qq-mode-console` 做对照也一样），所以配置界面走的是[面板](#面板配置界面)那条路。

顺手挖到 volatile 的真实语义，这个坑不踩一次不会知道：

| 现象 | 真实行为 |
|---|---|
| 读 volatile 字段 | 它不是普通值，而是引用对象 `{ get() }`，必须 `.get()` |
| 默认值 | 仍然生效（`Config({}).dwellMinutes.get() === 5`） |
| `JSON.stringify(cfg)` | **静默丢掉**这些字段的值（函数不可序列化），键还在、值全变 `{}` —— 直接把配置写日志或落盘会得到假数据 |
| `structuredClone(cfg)` | 直接抛 `could not be cloned` |
| 官方解包方式 | `Config.simplify(cfg)` |

所以 `config.mjs` 在归一化之前先做一次 `unwrapVolatile()`，两种输入（解析后的引用 / 原始扁平值）都能吃。另有 10 条用例专门守这块。

### 真实 DSH 端到端：已跑通

装进 `desktop` profile 后重启，真实链路的实测结果是：

| 观察点 | 结果 |
|---|---|
| 设置 → 插件里的状态 | **运行中**（第一次是「启动失败」，见下） |
| 卡片上的配置状态 | **已启用**（schema 校验通过） |
| 我发完一条消息后静默 5 分钟 | `~/.dsh/dsh-away-notify/outbox/` 里出现了 `<时间戳>.eml` + `.txt` |
| 邮件内容 | `结束原因：completed`、`1 轮 · 26 次工具调用（5 次失败）`、`静默时长：5.1 分钟` —— 全部正确 |

**这一步抓到了两个只有真跑才会暴露的问题：**

| # | 问题 | 根因 |
|---|---|---|
| 1 | 插件在真实 DSH 里**启动失败** | cordis 的 ctx 是 Proxy，**裸读一个没有 inject 的服务会直接抛** `cannot get property "x" without inject`；可选链 `ctx?.x` 挡不住（抛的是属性读取本身）。而 `apply()` 开头就裸读 `ctx.settings`，且在 try/catch 外 |
| 2 | 邮件里 token 数字看不懂（总数 955 万，输入+输出只有 2.5 万） | `totalTokens` **包含缓存命中**（实测 `19255 = 17319 + 1536 + 400`），而我渲染时只列了输入/输出 |

顺带还发现：**会话标题会回落成 session id** —— 因为 `session/title` 事件（`seq=13`）在插件加载**之前**就产生了，插件收不到历史事件。已修：优先用 DSH 的 `sessionTitle` 服务（`svc.get(session)` 折叠会话日志，含启动前的标题），其次事件，最后 session 对象字段。

**已跑通**
- **122 个自动化用例全绿**：真实契约回归 + 设置卡片 + 客户端半边 + cordis ctx 形状 + 诊断日志 + README 结构 + CI/发布配置 + 状态机 / 摘要 / SMTP / 宿主接线
- 状态机：撤销、合并、busy 挂起、`maxDwellMs` 上限、多会话隔离、`onFire` 抛错不中断
- SMTP 客户端对着一个**真的 TCP 假服务器**跑完整对话：信封、base64 正文还原、`AUTH PLAIN`、PLAIN 不被支持时回落 `AUTH LOGIN`、明文连接拒绝发送凭据、密码错误报原文
- `apply()` 在各种 ctx 形状下都不抛（包括「除 `get` 外全部属性都抛」的极端 Proxy）；`ctx.on` / `settings` / `sessionTitle` 缺失时都只告警不抛错
- demo 端到端产出有效 `.eml`（RFC 2047 主题折行、base64 正文）
- **发布产物**：真打一个包，解开 tar 核对必需文件、`src/` 无遗漏、无 `test/`/`scripts/`/`node_modules/` 混入、包内 `dsh.bundle.patch` 仍在、entry id 仍等于命名空间，并对包内每个文件重跑一遍敏感信息规则
- **守卫都做过负向验证**：注入 UTF-8 BOM → 卫生检查确实红；把 `repository` 的 `OWNER` 换成真名 → 占位符提示确实消失

> 发布准备期间守卫抓到的两个真问题，都是自己引入的：`Out-File`/`Set-Content -Encoding utf8`
> 给 `package.json` 加了 **UTF-8 BOM**（`JSON.parse` 直接抛 `Unexpected token`），
> 以及临时文件被写进仓库根目录。前者已加 `utf8-bom` 规则永久守住，后者改成一律写 `.test-tmp/`。

**尚未验证**
- **没有对真实邮箱服务商完整投递过**：隐式 TLS / 真证书 / 真 EHLO 已用
  `pnpm run verify:smtp --probe` 对着 `smtp.qq.com:465` 验证通过（服务器还声明了
  `AUTH LOGIN PLAIN`，正好对上实现的回落顺序）；但带真实凭据发出并收到邮件这一步
  需要你自己的授权码才能验，脚本已经准备好（`pnpm run verify:smtp`）
- 面板在**真实界面里**的显示 —— 注入行/路由/信任栅栏/浏览器脚本都过了用例（含真 HTTP 冒烟），
  但「桌面壳把注入行应用到页面上、按钮真的出现」这一步离线跑不了，需要重启 DSH 看
- 未在 macOS / Linux 上验证

## 发布

> ⚠️ **npm 有个绕不过去的顺序问题。** npm 自己的文档（`npm-trust`）写着：
> *"Package must exist: The package you're configuring must already exist on the npm registry."*
> 包还不存在 → 配不了 Trusted Publisher → OIDC 发布必然 404。
> **所以首次发布只能用临时令牌引导一次**，之后就再也不用凭据了。
> `release.yml` 里两条发布路径按 `NPM_TOKEN` secret 是否存在自动二选一。

### 首次发布（一次性，含引导）

1. **建仓库并推送** —— 用 GitHub Desktop 的 **Publish repository** 即可（它会顺便把本地提交推上去），
   然后确认 `ci.yml` 绿。
2. **npm 账号开启 2FA**（Trusted Publishing 和令牌都要求账号级 2FA）。
3. **建一个 Granular Access Token** 并勾上 bypass 2FA。
   （注意这是 `npm publish` 用的；`npm trust` 命令本身反过来不接受这类令牌，但用不到它 —— 第 5 步走网页。）
4. **把它存成仓库 secret**：Settings → Secrets and variables → Actions → 新建 `NPM_TOKEN`。
5. **推 tag** → 本次走**引导发布**：

   ```sh
   git tag v0.1.0
   git push origin main --tags
   ```

6. 发布成功后，到 npm 包页面 **Settings → Trusted Publisher → GitHub Actions** 配好：

   | 字段 | 值 |
   |---|---|
   | 仓库 | `ktouch10/dsh-away-notify` |
   | workflow | `release.yml` |
   | environment | 留空 |

7. **删掉 `NPM_TOKEN` secret。** 从此所有发布自动走 OIDC，仓库里不再有任何 npm 凭据。

> fork 之后另发一个包的话，把 `package.json` 的 `repository` / `homepage` / `bugs` / `author`
> 与 `CHANGELOG.md` 末尾两个链接换成你自己的。`release.yml` 会在发布前拦住没填的情况
> （检查 `repository` 是否存在、是否还是模板占位符）。

### 之后发布一版

```sh
# 1. 改 package.json 的 version，并在 CHANGELOG.md 里补一节，提交
# 2. 打 tag 推上去，剩下的交给 release.yml（无凭据，走 OIDC）
git tag v0.1.1
git push origin main --tags
```

`release.yml` 会依次：校验 **tag 与 `package.json` 的 version 一致** → 校验 `repository` 不是占位符 →
`pnpm install --frozen-lockfile` → `pnpm run check`（同一个守卫）→ 按有无 `NPM_TOKEN` 选路径发布
（都带 `--provenance`）→ 创建 GitHub Release。任一步失败就停，不会发出半成品。

> 顺带一个 npm 的坑：**一个包的第一次发布无论加不加 `--tag` 都会占住 `latest`**，
> 而且 `npm dist-tag rm ... latest` 会被拒。所以别把预发布版当首次发布 —— 那会让
> `latest` 长期指向 RC。本仓库首次发的是稳定版 `0.1.0`，没有这个问题。

### 两个 workflow 各守什么

| workflow | 触发 | 做什么 |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | 每次 push / PR | Node **22 与 24** 矩阵跑 `pnpm run check`；另有一个**零依赖 job**：不执行任何 install，直接跑核心用例 + demo，并验证没有 `schemastery` 时设置卡片会**降级而不是崩** |
| [`release.yml`](.github/workflows/release.yml) | 推 `v*` tag | tag/version 一致性 → 占位符校验 → 全量检查 → 发布（有 `NPM_TOKEN` 走引导，否则走 OIDC）→ 建 Release |

### 本地与 CI 用同一条命令

```sh
pnpm run check          # 语法 + 140 个用例 + demo + 设置预览 + 卫生检查 + 发布产物检查
pnpm run check:hygiene  # 只跑敏感信息扫描
pnpm run check:tarball  # 只跑「真打一个包再核对内容」
```

`check:tarball` 会**真的**执行打包，然后解开 tar 逐条核对：必需文件在不在、`src/` 有没有漏文件、
包里有没有混进 `test/` `scripts/` `node_modules/`、包内 `package.json` 的 `dsh.bundle.patch` 还在不在、
`cordis.patch.yml` 的 entry id 是否仍等于设置命名空间，最后对包内每个文件再跑一遍敏感信息规则。
打不出包时它**直接失败**，不静默跳过 —— 否则 CI 会给人「已检查」的错觉。

## 排查：为什么没收到提醒

DSH **不保存插件主机端的输出**（它的 `logs/` 里只有崩溃日志），所以插件自己写一份很小的状态日志：

```
~/.dsh/dsh-away-notify/status.log
```

里面按时间顺序记着：`apply` 是否跑完、配置摘要（**凭据已脱敏**）、settings 服务可用性、
命名空间注册结果、`session/event` 订阅结果，以及之后每一次 **排定 / 撤销 / 挂起 / 投递**。

```sh
# 看最近发生了什么
tail -n 40 ~/.dsh/dsh-away-notify/status.log
```

日志有 256KB 上限，超了整份重写；目录不可写就静默降级 —— 写日志失败**永远不会**影响提醒本身。
`DSH_AWAY_NOTIFY_DIAG_DIR` 可以改目录（测试用它避免污染主目录）。

提醒真的发出去时，会在 `~/.dsh/dsh-away-notify/outbox/` 落一对 `<时间戳>.eml` + `.txt`。

## 先验证 SMTP 再指望它

发信失败最让人恼火的地方是「到用的时候才发现」。所以有一个验收脚本，它跑的是插件
**自己的**那段连接/TLS/EHLO/AUTH 代码（不是另写一份），凭据只从环境变量读，输出全程脱敏：

```sh
# 1) 只探测：连接 + TLS 握手 + EHLO，不发信、不送凭据（不需要账号）
$env:DSH_SMTP_HOST="smtp.qq.com"; $env:DSH_SMTP_PORT="465"
node scripts/verify-smtp.mjs --probe

# 2) 真发一封：需要账号与授权码
$env:DSH_SMTP_USER="you@qq.com"; $env:DSH_SMTP_PASS="你的授权码"
node scripts/verify-smtp.mjs
```

探测通过长这样（真机输出）：

```
220 newxmesmtplogicsvrszc43-0.qq.com XMail Esmtp QQ Mail Server.
250-AUTH LOGIN PLAIN XOAUTH XOAUTH2 ...
TLS ✓ 已加密    AUTH ✓ 服务器要求认证    282 ms
```

失败时会按错误类型给提示（授权码不对 / 连不上 / 证书不匹配 / 服务器没提供 STARTTLS）。

> **QQ 邮箱必须用「授权码」**（设置 → 账户 → 开启 POP3/SMTP 服务后生成），不是登录密码。
> 另外 465 用隐式 TLS、587 用 STARTTLS —— 端口和 `smtpSecure` 配错是最常见的失败原因。
> `pnpm run verify:smtp -- --help` 有完整环境变量列表。

## 路线图

- [x] ~~真实进程端到端验证~~ —— 已完成：装进 desktop profile，真实 DSH 里跑通，
  设置页显示「运行状态：运行中」，5 分钟静默后 `outbox` 里出现了正确的提醒
- [x] ~~带表单的面板~~ —— 已完成，走的是**宿主端自己服务面板**的路子：界面左下角一个「提醒」
  按钮，点开是分四组的 22 个字段，保存写入覆盖层并实时生效。原生设置页（`dsh.client`）那条路
  试过但会让 DSH 起不来，原因见[面板](#面板配置界面)一节（客户端 bundle 需要构建步骤）
- [ ] 用 `tree/settled` 语义替代裸 `turn/end`，把子代理树也纳入「真的干完了」
- [ ] 客户端 presence：`document.hidden` / focus 回传宿主，让「人在不在」有比 `user/message` 更早的信号
- [ ] 卡片里显示运行状态（待发提醒数、最近一次投递），而不只是配置
- [ ] 免打扰时段、多通道扇出（webhook / Bark / 飞书）

## License

MIT
