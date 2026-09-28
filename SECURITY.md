# 安全说明

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的 [私密漏洞报告](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)（仓库 Security → Report a vulnerability），或直接联系仓库维护者。

请附上：影响的版本、复现步骤、以及你判断的影响面。

## 这个插件会碰到哪些敏感数据

理解风险面比读一遍代码更快：

| 数据 | 去哪 | 说明 |
|---|---|---|
| SMTP 密码 / 授权码 | 你的 SMTP 服务器 | 优先级：设置里的字面量 > `smtpPassEnv` 指定的环境变量。**建议只用环境变量** |
| 会话标题、最后一段助手回复、工具名与失败数 | 你配置的收件邮箱 | 这是提醒的正文。用第三方邮箱意味着这些内容会经过对方服务器 |
| 已发出的提醒 | 本地 outbox 目录（`transport: outbox` 时） | 明文 `.eml`，权限沿用你的用户目录 |

## 已经做了的防护

- **明文连接上拒绝发送凭据。** `secure: false` 且服务器不支持 STARTTLS 时，如果有用户名，客户端直接报错而不是把密码发出去。只有在显式设 `allowInsecureAuth: true` 时才放行 —— 那**只**应该用于本地测试服务器。
- **设置里的密码不回传浏览器。** schema 里标了 `role('secret')`，主机端不会把值发给前端；卡片上只显示「已配置 / 未配置」。
- **不把密码写进日志。** 投递失败只记录错误信息与服务器原文，凭据在 `AUTH` 之后不会回显。
- **仓库卫生守卫。** `pnpm run check:hygiene` 会拦住本机路径、私钥块、常见 API key 形状、手机号、真实邮箱，以及被写成字面量的凭据；`pnpm run check:tarball` 会**真的打一个包**出来，对包内每个文件再跑一遍同样的规则。
- **发布走 OIDC，长期不存任何 npm 凭据。** `release.yml` 用 npm Trusted Publishing 发布并带 provenance 签名。
  ⚠️ 唯一的例外是**首次发布**：npm 要求包已存在才能配 Trusted Publisher，所以第一版必须用一个临时
  `NPM_TOKEN` 引导。**引导成功后请立刻删除该 secret**，之后所有发布自动走 OIDC。
  如果仓库里长期留着 `NPM_TOKEN`，那就是一条能被用来发布你包的可写凭据 —— 与这里的设计意图相反。

## 需要你自己注意的

- **提醒内容会离开你的机器。** 会话标题与回复摘要会发到你的邮箱服务商。如果会话里出现过敏感内容，标题也可能带上它。
- **不要把密码提交进 git。** 用 `DSH_SMTP_PASSWORD` 之类的环境变量。`.env` 已在 `.gitignore` 里，但历史里的东西删不干净。
- **QQ / 163 等邮箱要用「授权码」而不是登录密码**，并注意授权码等同于该邮箱的收信权限。
- **`allowInsecureAuth` 不要在生产开。**
- 这个插件以 DSH 进程的权限运行，能读会话日志、能出网。装之前确认你信任这个包（这适用于所有 DSH 插件，不只本插件）。

## 支持范围

只有 `main` 分支上的最新版本会被修复。DSH 本体仍在 `0.1.x`，事件契约可能变化；上游一改，这里的兼容层会跟着更新。
