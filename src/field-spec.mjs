// 字段规格 —— 面板（和任何未来的界面）的**单一来源**。
//
// 为什么单独一个文件：字段的「短标签 / 分组 / 数值范围 / 枚举选项」既不属于 schema
// （schema 管的是校验与默认值），也不该在界面里再抄一份。宿主把它下发给面板，
// 面板只管渲染 —— 加字段时只改这里和 settings.mjs 的默认值/描述，两边由用例钉住。
//
// 这里用普通 JS 对象（不需要是 JSON），因为它是宿主端代码，不经过任何序列化边界。

/** 分组顺序即界面顺序。 */
export const FIELD_GROUPS = Object.freeze(['基本', '触发规则', '投递', 'SMTP'])

/**
 * 22 个字段。
 * type：boolean / number / text / secret / select
 * 数值字段带 min/max；枚举字段的 options 由 settings.mjs 的 SETTINGS_ENUMS 提供，
 * 这里只写展示文案（避免第二份枚举真值）。
 */
export const FIELD_SPECS = Object.freeze([
  { key: 'enabled', type: 'boolean', group: '基本', label: '总开关', help: '关掉后完全不监听事件' },
  { key: 'dwellMinutes', type: 'number', group: '基本', min: 0, max: 1440, label: '静默时长（分钟）', help: '核心旋钮：回合结束后安静这么多分钟仍无用户消息才提醒。0 = 干完就发' },
  { key: 'maxDwellMinutes', type: 'number', group: '基本', min: 1, max: 1440, label: '最晚推迟（分钟）', help: '同一批工作反复续跑时，最晚推迟到「首个回合结束 + 这么多分钟」' },
  { key: 'tickSeconds', type: 'number', group: '基本', min: 1, max: 600, label: '轮询间隔（秒）', help: '多久检查一次到没到点。不影响提醒时机，只影响精度' },
  { key: 'cancelOnUserMessage', type: 'boolean', group: '触发规则', label: '真人回话就撤销', help: '真正的用户消息会撤销待发提醒（DSH 注入的非人类消息不算）' },
  { key: 'cancelOnTurnStart', type: 'boolean', group: '触发规则', label: '开新回合也撤销', help: '默认关闭。目标续跑与后台唤醒都会开新回合，开了会被系统行为不断撤销' },
  { key: 'minToolCalls', type: 'number', group: '触发规则', min: 0, max: 1000, label: '最少工具调用次数', help: '低于这个次数的批次静默。0 = 关闭该规则' },
  { key: 'suppressEmptyTurns', type: 'boolean', group: '触发规则', label: '空回合不提醒', help: '既没有工具调用也没有回复文本的空回合不提醒' },
  { key: 'transport', type: 'select', group: '投递', label: '通道', help: 'outbox 落盘（零配置即可验证）；smtp 才会真的发信', optionText: { outbox: 'outbox（落盘）', smtp: 'smtp（真的发邮件）' } },
  { key: 'outboxDir', type: 'text', group: '投递', label: '落盘目录', help: '留空 = ~/.dsh/dsh-away-notify/outbox' },
  { key: 'subjectPrefix', type: 'text', group: '投递', label: '主题前缀', help: '邮件主题前缀' },
  { key: 'language', type: 'select', group: '投递', label: '邮件语言', help: '只影响邮件正文，不影响界面', optionText: { zh: '中文', en: 'English' } },
  { key: 'excerptChars', type: 'number', group: '投递', min: 0, max: 20000, label: '附带回复字数', help: '正文里附带「最后一段回复」的最大字符数。0 = 不附带' },
  { key: 'smtpHost', type: 'text', group: 'SMTP', label: '服务器', help: '例如 smtp.qq.com' },
  { key: 'smtpPort', type: 'number', group: 'SMTP', min: 1, max: 65535, label: '端口', help: '465（隐式 TLS）/ 587（STARTTLS）' },
  { key: 'smtpSecure', type: 'boolean', group: 'SMTP', label: '隐式 TLS', help: '465 端口通常 true，587 通常 false' },
  { key: 'smtpUser', type: 'text', group: 'SMTP', label: '登录账号', help: 'QQ 邮箱就是完整地址' },
  { key: 'smtpPass', type: 'secret', group: 'SMTP', label: '密码 / 授权码', help: '明文落盘有风险，建议留空改用下面的环境变量；留空即不修改' },
  { key: 'smtpPassEnv', type: 'text', group: 'SMTP', label: '密码所在环境变量', help: '留空则只认上面那一栏' },
  { key: 'smtpFrom', type: 'text', group: 'SMTP', label: '发件人', help: '留空 = 用登录账号' },
  { key: 'smtpTo', type: 'text', group: 'SMTP', label: '收件人', help: '多个用逗号分隔。留空 = 发给自己' },
  { key: 'allowInsecureAuth', type: 'boolean', group: 'SMTP', label: '允许明文认证', help: '仅限本地测试服务器。生产环境不要开' }
])
