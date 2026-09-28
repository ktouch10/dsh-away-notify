// 真实事件样本。
//
// 来源：本机 DSH 会话日志
//   <DSH_HOME>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
//   （DSH 0.1.7-rc.2，555 条记录）
//
// 采集方式：node scripts/inspect-session.mjs
//
// ⚠️ 这个文件里**没有任何来自真实会话的标识符**。
//   字段名与嵌套结构是逐字照抄的（那才是本文件的用途），但所有 id / callId / rpcId /
//   session id 都已替换成**明显的合成值**，不指向任何一次真实运行。路径、邮箱、会话标题
//   也都是构造的占位内容。这样即使有人拿到这个仓库，也无法把样本关联回某台机器上的日志。
//
// 重新采集（DSH 升级后契约可能再变，用这个核对；采集到的原始日志不要提交）：
//   node scripts/inspect-session.mjs                # 看全部关键类型
//   node scripts/inspect-session.mjs --type turn/end

const T = 1790561000000 // 基准时间（epoch ms）
const at = seconds => T + seconds * 1000

// 合成标识符：形状与真实值一致（UUID v4 / tool call id），但取值一眼可辨是假的。
const uid = n => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`
const cid = n => `call_00_SYNTHFIXTURE${String(n).padStart(12, '0')}`

export const SESSION_TITLE = {
  type: 'session/title',
  seq: 13,
  time: at(-1000),
  data: { title: '示例会话标题', messageSeqs: [8], source: { kind: 'fallback' } }
}

export const TURN_START = {
  type: 'turn/start',
  seq: 100,
  time: at(0),
  data: { turn: 5 }
}

// 真实 content 分片类型有三种：reasoning / text / tool-call（本会话统计 77 / 49 / 111）。
// 摘要只该取 text。
export const ASSISTANT_MESSAGE = {
  type: 'assistant/message',
  seq: 116,
  time: at(16),
  data: {
    turn: 5,
    step: 3,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '示例推理：这里的内容不会进入摘要' },
        { type: 'text', text: '示例回复：任务已完成，测试通过。' },
        { type: 'tool-call', id: cid(1), name: 'pwsh', arguments: '{"command":"npm test"}' }
      ],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      id: uid(1)
    },
    // 真实 usage 键名（本版本没有 reasoningTokens）
    usage: {
      inputTokens: 490,
      outputTokens: 361,
      cacheReadTokens: 19200,
      cacheWriteTokens: 0,
      totalTokens: 20338
    }
  }
}

export const TOOL_CALL = {
  type: 'tool/call',
  seq: 110,
  time: at(10),
  data: {
    turn: 5,
    step: 3,
    callId: cid(1),
    name: 'pwsh',
    arguments: '{"command":"npm test"}'
  }
}

export const TOOL_RESULT_OK = {
  type: 'tool/result',
  seq: 111,
  time: at(11),
  data: {
    turn: 5,
    step: 3,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: cid(1) },
      toolCallId: cid(1),
      content: [{ type: 'text', text: 'all tests passed' }],
      isError: false,
      id: uid(2)
    },
    meta: { path: 'C:\\workspace\\demo\\src\\index.mjs', offset: 1, lines: 3, totalLines: 197 }
  }
}

export const TOOL_CALL_FAIL_A = {
  type: 'tool/call',
  seq: 112,
  time: at(12),
  data: {
    turn: 5,
    step: 4,
    callId: cid(2),
    name: 'pwsh',
    arguments: '{"command":"node scripts/missing.mjs"}'
  }
}

// 失败样本 A：**只有 message.isError，顶层没有 error 对象**。
// 旧代码只查顶层 → 这条会漏掉。这是真实契约核对抓到的第二个 bug。
export const TOOL_RESULT_ERROR = {
  type: 'tool/result',
  seq: 113,
  time: at(13),
  data: {
    turn: 5,
    step: 4,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: cid(2) },
      toolCallId: cid(2),
      content: [{ type: 'text', text: 'Error: spawn EPERM' }],
      isError: true,
      id: uid(3)
    }
  }
}

export const TOOL_CALL_FAIL_B = {
  type: 'tool/call',
  seq: 114,
  time: at(14),
  data: {
    turn: 5,
    step: 5,
    callId: cid(3),
    name: 'web_fetch',
    arguments: '{"url":"https://example.invalid"}'
  }
}

// 失败样本 B：真实日志里抛出带类型的错误时，顶层额外还有一个 error 对象。
export const TOOL_RESULT_ERROR_TYPED = {
  type: 'tool/result',
  seq: 115,
  time: at(15),
  data: {
    turn: 5,
    step: 5,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: cid(3) },
      toolCallId: cid(3),
      content: [{ type: 'text', text: 'sandbox unavailable' }],
      isError: true,
      id: uid(4)
    },
    error: { name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' }
  }
}

// 真实形状是对象，不是字符串 —— 旧代码 String() 会得到 "[object Object]"。
// 这是真实契约核对抓到的**最致命**的 bug：每封邮件的「结束原因」都会错，
// 而且会被判成非正常完成。
export const TURN_END_COMPLETED = {
  type: 'turn/end',
  seq: 120,
  time: at(20),
  data: { turn: 5, reason: { kind: 'completed' } }
}

export const TURN_END_ERROR = {
  type: 'turn/end',
  seq: 121,
  time: at(21),
  data: { turn: 5, reason: { kind: 'error' } }
}

// ── 四种「role 也是 user、但不是人」的注入消息 ──────────────────────────
// 这是本插件最关键的过滤器：只按 role === 'user' 判断的话，这些每回合都会到，
// 待发提醒会被系统行为一次次撤销 —— 插件看起来正常，但永远不发信。

export const RUNTIME_CONTEXT_MESSAGE = {
  type: 'user/message',
  seq: 130,
  time: at(30),
  data: {
    content: [{ type: 'text', text: '示例运行时上下文快照。' }],
    source: {
      kind: 'runtime-context',
      form: 'snapshot',
      sections: [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }]
    },
    role: 'user',
    id: uid(11)
  }
}

export const SKILL_CATALOG_MESSAGE = {
  type: 'user/message',
  seq: 131,
  time: at(31),
  data: {
    content: [{ type: 'text', text: '示例技能清单。' }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries: [{ name: 'office-docx', description: 'Create, read, edit, and check Word documents.' }]
    },
    role: 'user',
    id: uid(12)
  }
}

export const AGENT_MESSAGE = {
  type: 'user/message',
  seq: 132,
  time: at(32),
  data: {
    content: [{ type: 'text', text: 'Subagent finished.' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: uid(90) },
    role: 'user',
    id: uid(13)
  }
}

// 后台子代理落定 —— 正好是「合并」场景里必须不能当成「人回来了」的那一类。
export const SUBAGENT_SETTLED = {
  type: 'user/message',
  seq: 133,
  time: at(33),
  data: {
    content: [{ type: 'text', text: 'Background subagent settled.' }],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary: `Background subagent ${uid(90)} finished.`
    },
    role: 'user',
    id: uid(14)
  }
}

// 真正的人类消息
export const USER_MESSAGE = {
  type: 'user/message',
  seq: 140,
  time: at(40),
  data: {
    content: [{ type: 'text', text: '请继续' }],
    source: { kind: 'user', rpcId: uid(80), clientTimeZone: 'UTC' },
    role: 'user',
    id: uid(15)
  }
}

/** 一次完整的真实回合：turn/start → 3 次工具调用（2 次失败）→ 回复 → turn/end。 */
export const FULL_TURN = [
  TURN_START,
  TOOL_CALL,
  TOOL_RESULT_OK,
  TOOL_CALL_FAIL_A,
  TOOL_RESULT_ERROR,
  TOOL_CALL_FAIL_B,
  TOOL_RESULT_ERROR_TYPED,
  ASSISTANT_MESSAGE,
  TURN_END_COMPLETED
]

/** 所有「role=user 但非人类」的注入消息。 */
export const INJECTED_USER_MESSAGES = [
  RUNTIME_CONTEXT_MESSAGE,
  SKILL_CATALOG_MESSAGE,
  AGENT_MESSAGE,
  SUBAGENT_SETTLED
]
