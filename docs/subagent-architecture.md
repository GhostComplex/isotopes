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

### 4.4 目标布局：对齐 openclaw（计划项）

**现状的两个根**（§4.2 表里那两条 dataDir）和"主 agent / subagent 各自一套 store 实例"是历史遗留。计划在独立 PR 里把整个存储层对齐 openclaw：主 + sub 共用一个根目录、一个 manager、一种 agentId 体系。**不做向后兼容**——切换后旧路径下的 transcript 文件物理上还在，但代码不再读，等同于失忆。

#### 核心原则（直接抄 openclaw）

1. **agentId 永远是真实的**——主 agent 用它配置里的真实 ID，命名 subagent（比如 `code-reviewer`）用自己的真名，**没有"虚拟 agentId"概念**（不再有 `subagent:<parent>:<task>` 这种合成 ID）。
2. **匿名/动态 subagent fallback 到父 agent 的 ID**——没指定 `targetAgentId` 时，session 直接落在父 agent 目录下。
3. **"这是 subagent run" 的信息塞进 sessionKey，不进 agentId**——key 形如 `agent:<targetAgentId>:subagent:<uuid>`。
4. **目录由真实 agentId 决定**——`agents/<normalizedAgentId>/sessions/`。同一个 agent 当主 agent 跑 / 被 spawn 当 subagent 跑，落在同一个目录，sessionId 不同。

为什么这样不会污染：`getMessages(sessionId)` 是按 sessionId 拉单个 session 文件，不是按目录扫。同一目录下放 N 个 session 互不影响，主 agent 拼 prompt 时只读自己那个 session，碰不到 subagent 的。

#### 三种调用场景的落点

| 场景 | 用什么 agentId | 落在哪 | session 连续性 |
|---|---|---|---|
| 主 agent (`alice`) 处理 user 消息 | `alice` | `agents/alice/sessions/<sid>.jsonl` | 按 binding key 复用同一 sessionId |
| 主 agent 调命名 subagent (`code-reviewer`) | `code-reviewer` | `agents/code-reviewer/sessions/<sid>.jsonl` | 默认每次新 sessionId；想连续就在 sessionKey 里编码上下文 |
| 主 agent 起匿名/动态 subagent (claude/builtin) | **父 agent** (`alice`) | `agents/alice/sessions/<sid>.jsonl` | 不复用，每次新 sessionId |

#### 目标架构 ASCII

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              cli.ts (startup)                              │
│                                                                            │
│   sessionStoreManager = new SessionStoreManager()                          │
│                                                                            │
│       getOrCreate(agentId): DefaultSessionStore                            │
│         ├─ normalized = normalizeAgentId(agentId)                          │
│         ├─ dataDir   = ~/.isotopes/agents/<normalized>/sessions/           │
│         └─ memoize in Map<normalizedId, store>                             │
└─────────────────────────────────┬─────────────────────────────────────────┘
                                  │ inject
              ┌───────────────────┴────────────────────┐
              ▼                                        ▼
   ┌────────────────────────┐              ┌──────────────────────────┐
   │ DiscordTransport       │              │ spawnSubagent            │
   │   (主 agent 写入侧)    │              │   (subagent 写入侧)       │
   │                        │              │                          │
   │ targetId = agentId     │              │ targetId =               │
   │ key = bindingSessionKey│              │   opts.targetAgentId     │
   │                        │              │   ?? parentAgentId        │
   │ store = manager        │              │ key = `agent:${targetId}:│
   │   .getOrCreate(        │              │       subagent:${uuid}`  │
   │      targetId)         │              │ store = manager          │
   │                        │              │   .getOrCreate(targetId) │
   │ store.addMessage(      │              │                          │
   │   sid, userMsg)        │              │ recorder = createRecord( │
   │ store.addMessage(      │              │   { store, sessionKey })  │
   │   sid, assistantMsg)   │              │                          │
   └──────────┬─────────────┘              └─────────┬────────────────┘
              │                                       │
              │ addMessage / setMetadata              │ addMessage / setMetadata
              ▼                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │            DefaultSessionStore (一种类)              │
        │   - addMessage / getMessages / setMetadata / ...     │
        │   - 同一份 JSONL 落盘逻辑                            │
        └──────────────┬───────────────────────────────────────┘
                       │ 文件操作
                       ▼

  磁盘布局 — 主 / 命名 sub / 匿名 sub 全按真实 agentId 分目录：

  ~/.isotopes/
    agents/
      ├── alice/                           ← 主 agent ID = "alice"
      │     └── sessions/
      │           ├── sessions.json        ← 索引
      │           ├── <sid-1>.jsonl        ← user ↔ alice 对话
      │           ├── <sid-2>.jsonl        ← alice 起的匿名 subagent
      │           └── <sid-3>.jsonl        ← alice 起的另一个匿名 subagent
      │                                       (sessionKey 里有 :subagent:uuid)
      │
      ├── bob/                             ← 主 agent ID = "bob"
      │     └── sessions/...
      │
      └── code-reviewer/                   ← 命名 subagent，被 alice / bob 都调用过
            └── sessions/
                  ├── sessions.json
                  ├── <sid-a>.jsonl        ← 给 alice 审过的一次
                  └── <sid-b>.jsonl        ← 给 bob 审过的一次
```

#### 写入侧分工（调用栈对照）

```
  主 agent path                          subagent path (named or anon)
  ─────────────                          ─────────────────────────────
  user msg arrives in Discord            主 agent 决定 spawn_subagent
        │                                      │
  DiscordTransport.handleMessage         ToolRegistry → spawn_subagent
        │                                      │
  targetId = agentId                     targetId = opts.targetAgentId
        │                                          ?? parentAgentId
        │                                      │
  manager.getOrCreate(targetId)          manager.getOrCreate(targetId)
        │                                      │
  key = bindingSessionKey(channel,...)   key = `agent:${targetId}:
        │                                       subagent:${uuid}`
  session = store.findByKey(key)               │
            ?? store.create(targetId, ...)  session = store.create(
        │                                       targetId,
  store.addMessage(sid, userMsg)               { ...metadata,
        │                                         sessionKey: key })
  agent.prompt(messages)                       │
        │                                createSubagentRecorder(
  on agent_end:                            { store, sessionId, ... })
  store.addMessage(sid, assistantMsg)          │
                                         backend.spawn(taskId, opts)
                                               │
                                         for await (event):
                                           recorder.record(event)
                                              ↓
                                           store.addMessage(sid, msg)
```

#### sessionKey 形态

| 调用类型 | sessionKey 格式 | 复用规则 |
|---|---|---|
| 主 agent 来自 transport | `discord:<botId>:channel:<cid>:<agentId>` | 同一 (channel × agent) 复用 |
| 命名 subagent | `agent:<targetAgentId>:subagent:<uuid>` | 默认每次新；自定义 key 可达成连续性 |
| 匿名 subagent | `agent:<parentAgentId>:subagent:<uuid>` | 默认每次新 |

#### 共用 / 各自一览

```
                       ┌──────── 共用 ────────┐  ┌── 各自 ──┐
  存储类               │ DefaultSessionStore  │
  Message schema       │ 同一份                │
  JSONL 格式           │ 同一份                │
  setMetadata 路径     │ 同一份                │
  Manager              │ SessionStoreManager  │
  根目录               │ ~/.isotopes/agents/  │
  agentId 体系         │ 都是真实 agentId      │
                                                │ store 实例 │ per-agentId
                                                │ 写入触发器 │ transport vs recorder
                                                │ sessionKey │ binding key vs
                                                │  生成规则  │  agent:...:subagent:uuid
                                                │ 复用粒度   │ 主连续 / sub 默认一次性
```

#### 与 openclaw 对照

```
  openclaw                                我们 (对齐后)
  ──────────                              ─────────────
  <stateDir>/agents/<id>/sessions/        ~/.isotopes/agents/<id>/sessions/
  normalizeAgentId() 把 :,/ 替成 -        同
  per-agentId store 实例                   同 (SessionStoreManager 提供)
  agentId 永远真实，无合成 ID              同
  匿名 sub 落父 agent 目录                 同
  sessionKey: agent:<id>:subagent:<uuid>  同
  主 agent + 命名 sub + 匿名 sub 同根     同
  无 workspace-local                      同 (砍掉旧分支)
```

#### 改动清单

- `paths.ts`：加 `normalizeAgentId()`（小写 + `[^a-z0-9_-]+ → -`）和 `getAgentSessionsDir(agentId)`。
- 新建 `SessionStoreManager`（或 cli.ts 内联 `Map<normalizedId, DefaultSessionStore>`），主 + sub 都从这里取。
- `cli.ts`：主 agent store 创建走 manager，去掉 workspace-local 分支；删掉 `setSubagentSessionStore` 单例调用。
- `tools/subagent.ts`：
  - 接受可选 `targetAgentId`；没传就 fallback 到 `parentAgentId`
  - sessionKey 用 `agent:${targetId}:subagent:${randomUUID()}`
  - 拿 `manager.getOrCreate(targetId)` 注入 recorder
- `subagent/persistence.ts`：删掉 `subagentAgentId()` / vid 概念；recorder 接收外部传入的 `targetAgentId` + `sessionKey`。
- `core/types.ts`：`SubagentSessionMetadata.parentSessionId` 保留；考虑把 `transport: 'subagent'` 这条挪走（subagent 不是 transport，应作为 session metadata 的 `kind` 字段）。
- 测试 dataDir / sessionKey 全更新；明确不写迁移代码。

不在范围内：旧数据迁移、向后兼容 fallback、workspace-local sessions、命名 subagent 的"上下文连续性"高级机制（基础设施留好接口，具体策略另开 issue）。

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
