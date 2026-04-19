# Subagent architecture

设计目标：主 agent 可以把"独立子任务"交给一个 subagent 跑。subagent 有两种 backend：

- **`claude`** — 现有实现，调用 `@anthropic-ai/claude-agent-sdk` 起一次 `query()`，跑独立 Claude Code 进程上下文。
- **`builtin`** — 新增（issue #399），在本进程内复用 `PiMonoCore`，吃同一份 provider/model 配置，无需 Claude SDK / 单独 API key。

不管哪种 backend，对外都暴露同一套 `SubagentEvent` 流；上层（DiscordSink、thread-binding、`/stop`、persistence recorder）一律不变。

## 1. 组件总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Main agent (PiMonoCore)                    │
│  - 处理用户消息                                                     │
│  - tools 中暴露 spawn_subagent                                      │
└─────────────────────────────┬───────────────────────────────────────┘
                              │  调用 spawn_subagent(prompt, opts)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     spawnSubagent (src/tools/subagent.ts)           │
│  - 生成 taskId                                                      │
│  - taskRegistry.register(taskId)        ← /stop 用                  │
│  - createSubagentRecorder({ store, parentAgentId, taskId, ... })    │
│  - backend.spawn(taskId, opts)  → AsyncIterable<SubagentEvent>      │
└──────────────┬──────────────────────────────────────────┬───────────┘
               │ for await (event of backend.spawn(...))  │
               │                                          │
               ▼                                          ▼
   ┌────────────────────────┐              ┌──────────────────────────┐
   │  SubagentBackend       │              │  SubagentRunRecorder     │
   │  (multiplexer)         │              │  (persistence.ts)        │
   │                        │              │                          │
   │  switch (agent) {      │              │  record(event):          │
   │    "claude"  → SDK     │              │    eventToMessage()      │
   │    "builtin" → PiMono  │              │    store.addMessage(...) │
   │  }                     │              │                          │
   │                        │              │  patchMetadata(patch):   │
   │  yield SubagentEvent   │              │    store.setMetadata(...)│
   └─────┬────────────┬─────┘              └────────┬─────────────────┘
         │            │                             │
         ▼            ▼                             ▼
  ┌───────────┐ ┌──────────────┐          ┌────────────────────────┐
  │ Claude    │ │ PiMonoCore   │          │ DefaultSessionStore    │
  │ Agent SDK │ │ (in-process) │          │ ~/.isotopes/           │
  │ query()   │ │ Agent.run()  │          │   subagent-sessions/   │
  └───────────┘ └──────────────┘          └────────────────────────┘
```

下游消费者（独立于 backend）：

```
SubagentEvent stream
    ├─→ DiscordSink         (toolCalls / thinking / 进度)
    ├─→ thread-binding      (autoUnbindOnComplete on done)
    ├─→ taskRegistry        (运行状态、/stop 解除)
    └─→ SubagentRunRecorder (落盘到 SessionStore)
```

## 2. 调用链 — 主 agent 触发到事件落盘

```
User message
   │
   ▼
DiscordTransport.handleMessage
   │
   ▼
AgentInstance.prompt(input)              ← PiMonoCore
   │
   │  LLM 决定调用 spawn_subagent 工具
   ▼
ToolRegistry → spawn_subagent handler  (src/core/tools.ts)
   │
   │  工具 handler 已知 parentAgentId（在 createWorkspaceToolsWithGuards 注入）
   ▼
spawnSubagent(prompt, { agent, cwd, parentAgentId, threadId, ... })
   │
   ├──► taskRegistry.register(taskId, sessionId, channelId, prompt)
   │      └─► taskRegistry.setThreadId(taskId, threadId)  // /stop 路由
   │
   ├──► createSubagentRecorder({ store, parentAgentId, parentSessionId,
   │                             taskId, backend, cwd, prompt, channelId,
   │                             threadId })
   │      └─► store.create(`subagent:${parent}:${task}`, metadata)
   │            (虚拟 agentId — 见 docs/subagent-persistence.md)
   │
   └──► for await (event of backend.spawn(taskId, options)) {
          options.onEvent?.(event)        // DiscordSink、上层订阅者
          recorder.record(event)          // 落盘 message / tool_use / tool_result / error
          if (terminal) recorder.patchMetadata(terminalEventPatch(event))
        }
   │
   ▼
return SpawnSubagentResult { success, output, error, exitCode, eventCount }
```

## 3. SubagentBackend — 多路复用层（要新写的部分）

现状（main 上的 `src/subagent/backend.ts`）只有 claude 一条路径。`#399` 要做的就是把 `class SubagentBackend` 拆成 dispatcher + 两个 backend 实现。

### 3.1 现状

```
class SubagentBackend {
  spawn(taskId, options) {
    validateAgent(options.agent)        // 只接受 "claude"
    validateCwd(options.cwd)
    yield { type: "start" }
    for await (msg of query({ prompt, options: buildSdkOptions(...) })) {
      for (ev of mapSdkMessage(msg, toolNameById)) yield ev
    }
    yield { type: "done", ... }
  }
}
```

### 3.2 目标形态

```
interface SubagentRunner {
  run(taskId, options, signals): AsyncGenerator<SubagentEvent>
}

class SubagentBackend {
  private runners: { claude: ClaudeRunner; builtin: BuiltinRunner }

  async *spawn(taskId, options) {
    const runner = this.runners[options.agent]
    yield { type: "start" }
    yield* runner.run(taskId, options, { abort, timeout })
    // dispatcher 仍负责：
    //   - taskId → AbortController 注册（cancel/cancelAll 复用）
    //   - 并发上限（MAX_CONCURRENT_AGENTS）
    //   - timeout 超时
    //   - "确保至少一个 done" 安全网
  }
}
```

两个 runner：

```
ClaudeRunner.run(taskId, opts, signals):
  for await (msg of query({ prompt, options: sdkOptions })) {
    yield* mapSdkMessage(msg, toolNameById)
  }

BuiltinRunner.run(taskId, opts, signals):
  agent = piMonoCore.createAgent({
    id: `subagent-${taskId}`,
    systemPrompt: opts.systemPrompt ?? DEFAULT_BUILTIN_PROMPT,
    tools: filterTools(parentToolset, opts.allowedTools),  // 复用主 agent 的 tool registry
    provider: parentProviderConfig,                        // 继承 provider，无需新 key
    sandbox: opts.sandbox,
    compaction: { mode: "off" }                            // subagent 默认短任务
  })
  for await (ev of agent.prompt(opts.prompt)) {
    yield* mapAgentEvent(ev)   // AgentEvent → SubagentEvent
  }
```

### 3.3 事件映射表（builtin 新增）

| `AgentEvent`  | `SubagentEvent`               | 备注 |
|---------------|-------------------------------|------|
| `turn_start`  | —                             | 忽略（无对应概念） |
| `text_delta`  | `message` (按 turn 聚合)      | 累积成完整 message 后再 yield，避免每 token 一条 |
| `tool_call`   | `tool_use` (toolName/Input)   | 直接转 |
| `tool_result` | `tool_result` (toolName/Result) | 直接转 |
| `turn_end`    | —                             | 用 `usage.cost` 做 done.costUsd 累加 |
| `agent_end`   | `done` (exitCode / costUsd)   | 终结事件 |
| `error`       | `error` + `done` (exitCode=1) | 错误终结 |

`mapSdkMessage`（claude）已经做这件事；新增 `mapAgentEvent`（builtin）放在同一个 `backend.ts` 或拆 `backends/claude.ts` + `backends/builtin.ts`。

## 4. 与 SessionStore 的关系

### 4.1 主 agent 的 session 是怎么存的

主 agent 落盘走 transport 层（不是 recorder）。以 Discord 为例：

```
DiscordTransport.handleMessage(msg)
  │
  ├─► sessionStore = getSessionStore(agentId)              // 每个 agent 一个 store
  ├─► session = findOrCreateSession(sessionStore, key, ...)
  │
  ├─► sessionStore.addMessage(session.id, userMessage)     // 用户消息进 transcript
  │
  ├─► messages = sessionStore.getMessages(session.id)      // 把历史拼回 prompt
  ├─► agent.prompt(messages)                               // PiMonoCore 跑一轮
  │
  └─► for await (event of agent.prompt(...)) {
        on text_delta → 累积
        on agent_end  → sessionStore.addMessage(session.id, assistantMessage)
      }
```

代码位置：`src/transports/discord.ts:457-517` / `:721-817`，`src/cli.ts:1070-1119` 给每个 agent 建一个 `DefaultSessionStore`，按 agentId 路由（`discordSessionStores: Map<string, DefaultSessionStore>`）。

### 4.2 主 agent vs subagent 的存储对照

```
┌────────────────────────┐                  ┌──────────────────────────────┐
│ DiscordTransport       │                  │ spawnSubagent → Recorder     │
│ (transport-side write) │                  │ (sidecar write)              │
└──────────┬─────────────┘                  └──────────────┬───────────────┘
           │ addMessage                                    │ addMessage
           ▼                                               ▼
  ┌────────────────────┐                          ┌────────────────────┐
  │ DefaultSessionStore│                          │ DefaultSessionStore│
  │  (主 agent 实例)   │                          │  (subagent 实例)   │
  │  per-agent map     │                          │  全局单例          │
  └────────┬───────────┘                          └────────┬───────────┘
           │                                                │
           ▼                                                ▼
  ~/.isotopes/sessions/<agentId>/             ~/.isotopes/subagent-sessions/
  或 <workspace>/sessions/                      <virtualSid>.jsonl
  <sessionId>.jsonl                            (sessions.json 索引)
  (sessions.json 索引)
```

| 维度 | 主 agent | subagent |
|---|---|---|
| 存储类 | `DefaultSessionStore` | **同** `DefaultSessionStore` |
| Message schema | `Message` (text / tool_result blocks) | **同** `Message` |
| 文件格式 | 每 session 一个 JSONL + 共享 `sessions.json` 索引 | **同** |
| 实例数量 | 每个 agent 一个 store | 一个全局 store |
| 写入入口 | transport 层（discord.ts / feishu.ts） | recorder（persistence.ts） |
| dataDir | `<workspace>/sessions/` 或 `~/.isotopes/sessions/<agentId>/` | `~/.isotopes/subagent-sessions/` |
| sessionId | UUID | UUID（agentId 是虚拟的 `subagent:<parent>:<task>`） |
| 拼回历史给 LLM | `getMessages(sid)` 拼成 prompt | **不拼** — subagent 每次都是新对话，transcript 只读不喂 |

要点：

1. **同一段存储代码、同一份数据结构**——`DefaultSessionStore` 类、`Message` 接口、JSONL 格式没分叉。任何对存储格式的演进（schema 升级、压缩、TTL）一次改两边都受益。
2. **不同的实例和不同的写入侧**——transport 在用户消息进来的边界写入；recorder 在 SubagentEvent 流里写入。两条路径都只是 `addMessage` 的客户端。
3. **dataDir 分开是有意的**——主 agent transcript 是"对话上下文"，会被读回去拼 prompt；subagent transcript 是"运行回放"，只供事后审计/调试，不参与下一轮 prompt。两边混在一起会让 `getMessages(sid)` 的语义混乱。

### 4.3 Recorder 是 backend-agnostic 旁路

Recorder 只看 `SubagentEvent`，根本不知道事件来自 SDK 还是 PiMonoCore：

```
                                           ┌──────────────┐
        backend.spawn(...)  ──► event ───► │ DiscordSink  │
                                           ├──────────────┤
                                event ───► │ Recorder     │ ──► SessionStore.addMessage
                                           ├──────────────┤
                          done/error  ───► │ Recorder     │ ──► SessionStore.setMetadata
                                           └──────────────┘
```

启动时 `cli.ts` 注入一个独立的 store（路径 `~/.isotopes/subagent-sessions`）：

```
cli.ts  init
  └─► subagentRunStore = new DefaultSessionStore({ dataDir: getSubagentSessionsDir() })
  └─► setSubagentSessionStore(subagentRunStore)
```

新增 builtin backend **不需要改 cli.ts**，也不需要改 recorder。`metadata.subagent.backend` 字段在创建 session 时由 `spawnSubagent` 写入（值为 `"claude"` / `"builtin"`），落盘后可按 backend 过滤。

## 5. 共享 vs 隔离

| 资源 | claude backend | builtin backend |
|---|---|---|
| 进程 | 独立 SDK runtime | **同进程**（PiMonoCore） |
| Provider / API key | SDK 自管，需要 Anthropic key | **复用主 agent 的 provider** |
| Tool 集合 | SDK 内置工具 + `allowedTools` 过滤 | 主 agent 的 ToolRegistry，按白名单过滤 |
| 工作目录校验 | `validateCwd` (allowedRoots) | 同上，复用 dispatcher 层 |
| Cancellation | `AbortController` → SDK | `AbortController` → `AgentInstance.abort()` |
| Timeout | 同上 | 同上 |
| 并发上限 | `MAX_CONCURRENT_AGENTS` | 同一计数（dispatcher 共享） |
| Persistence | 走 recorder | 走 recorder（同一份） |
| Discord 输出 | DiscordSink | DiscordSink |
| `/stop` | taskRegistry → backend.cancel | 同上 |

dispatcher 负责所有"通用机制"（并发、超时、cancel、validate、start/done 安全网），runner 只负责**生事件**。这样新增第三种 backend（比如未来 ACP）只需要写一个 `Runner`。

## 6. builtin backend 实现关键点

1. **Tool 子集**：默认 read-only fs + shell。从主 agent 的 `ToolRegistry` 借用工具实例（保留 sandbox guard），再用 `allowedTools` 过滤。
2. **Provider 继承**：`spawnSubagent` 当前接收 `model?: string`；builtin 还需要 `parentProvider: ProviderConfig`。在 `createSubagentTool` 把父 agent 的 `AgentConfig.provider` 抓出来作为 spawn options 传下去。
3. **System prompt**：subagent 需要自己的 prompt（不要继承父 agent 的 SOUL.md），默认走一个内置的"你是子任务执行者"模板，可被 `options.systemPrompt` 覆盖。
4. **Compaction**：默认关。子任务通常一两轮，用 `compaction.mode = "off"` 避免 context overflow 触发额外 LLM 调用。
5. **事件桥接**：`text_delta` 按 turn 聚合再 yield 一次 `message`，避免事件流被刷屏。
6. **生命周期**：`agent.abort()` 要在 dispatcher 收到 cancel 时调用；用完即丢，不要进 `AgentManager` 注册表（那是面向"长期 agent"的）。

## 7. 不在 #399 范围内

- 跨 backend 的"统一 sandbox 配置层"——claude SDK 自己有 permissions 模型，builtin 走我们的 `SandboxConfig`，目前各管各的。
- builtin backend 的子任务 trace 反向链回父 transcript（今天父端只看到 `tool_result` 文本）。
- 嵌套 subagent（builtin runner 里再 spawn subagent）。可以工作，但深度限制留到后面。

## 8. 验收对照（issue #399）

- [ ] `SubagentAgent` 联合扩成 `"claude" | "builtin"`，`SUBAGENT_AGENTS` 同步
- [ ] `spawnSubagent({ backend: "builtin", ... })` 不依赖 Claude SDK 跑通端到端
- [ ] DiscordSink / thread-binding / `/stop` 在两种 backend 下行为一致
- [ ] 单测覆盖 builtin 路径（mock provider / mock tool registry）
- [ ] `metadata.subagent.backend` 在 SessionStore 中正确记录两种值

## 9. 引用

- `src/subagent/backend.ts` — 现 dispatcher + claude runner
- `src/subagent/types.ts:11` — `SubagentAgent` 当前定义
- `src/tools/subagent.ts` — `spawnSubagent` 入口（recorder 已接好）
- `src/subagent/persistence.ts` — recorder + 事件→Message 适配
- `docs/subagent-persistence.md` — 上一阶段（#400）的持久化设计
- openclaw `pi-embedded-runner`、hermes `delegate_tool` — builtin 风格参考
