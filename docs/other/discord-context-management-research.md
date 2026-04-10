# Discord Context Management 调研

**日期:** 2026-04-10
**对比对象:** OpenClaw (`.ref/openclaw/`)
**相关文档:** `.ref/history-limit-refactor.md`（historyLimit 重构细节）、`docs/rca/2026-04-09-context-window-overflow.md`

---

## 背景

Isotopes 在 2026-04-09 发生 context window overflow 事故后，先紧急修复了 compaction 配置传递 bug（PR #70），随后将 `historyLimit` 从按消息条数截断改为按 user turn 截断（PR #71, #73）。本文档调研 OpenClaw 的 Discord context 管理方案，评估 Isotopes 的差距和改进方向。

---

## 1. 自建 vs 依赖 pi-mono

两个项目都基于 pi-mono（`@mariozechner/pi-agent-core`），对上游 SDK 的依赖边界高度一致：

**pi-mono 提供的（两个项目共用）：**
- `SessionManager` — JSONL 会话文件的读写和分支管理
- `estimateTokens()` — 基于 chars/4 的 token 估算
- `generateSummary()` — 底层 LLM 摘要调用
- `"context"` 事件钩子 — 模型调用前的消息列表修改点

**所有上下文管理策略都是各自自建的，pi-mono 不参与决策。** OpenClaw 在 `src/agents/` 和 `extensions/discord/` 中实现，Isotopes 在 `src/transports/discord.ts` 中实现。

---

## 2. 两种历史记录的处理

Discord channel 中存在两种本质不同的消息历史：

### 2.1 Channel History（群里其他人的消息）

指 bot 未被触发时，channel 中其他用户/bot 发送的消息。这些消息提供了对话上下文（"之前大家在聊什么"），但不属于 agent 的会话记录。

**OpenClaw 的做法：独立管理，注入 user message body**

```
┌──────────────────────────────────────────────────────────┐
│  guildHistories: Map<channelId, HistoryEntry[]>          │
│  - 纯内存，不调 Discord API，只记录 gateway 实时观察到的  │
│  - 默认上限 20 条/channel，全局最多 1000 channel（LRU）   │
│  - 未被 @mention 的消息也会被记录（只是不触发回复）        │
│  - bot 回复后清空该 channel 的积累，从头开始              │
└──────────────────────────────────────────────────────────┘
            ↓ 当 bot 被触发回复时
┌──────────────────────────────────────────────────────────┐
│  拼入 user message body（纯文本，不进 session）：         │
│                                                          │
│  [Chat messages since your last reply - for context]     │
│  [id:<msgId> channel:<chId>] Alice: 我觉得应该用 Redis   │
│  [id:<msgId> channel:<chId>] Bob: 不如直接用内存缓存      │
│                                                          │
│  [Current message - respond to this]                     │
│  @bot 你怎么看缓存方案？                                  │
└──────────────────────────────────────────────────────────┘
```

关键设计：
- channel history 标记为 untrusted，嵌在 user message 正文里
- **不进入 session JSONL**，不会在后续 turn 中重复出现
- 回复后清空，避免积累过多旧消息

**Isotopes 现状：无此机制。** 所有消息统一存入 session store，无法区分 channel context 和 agent session。

### 2.2 Agent Session（agent 自己的对话记录）

指 agent 的完整对话链：user prompt → assistant response → tool call → tool result → ...

**OpenClaw 的做法：多层防护**

```
Session messages (JSONL)
    ↓
limitHistoryTurns(messages, limit)     ← 按 user turn 截断
    ↓
sanitizeToolUseResultPairing()         ← 修复截断产生的孤立 tool_result
    ↓
context pruning (pi-hooks extension)   ← soft trim / hard clear tool results
    ↓
compaction (token 接近上限时)           ← 多阶段摘要替代直接丢弃
    ↓
发送给模型
```

**Isotopes 现状：只有第一层。** `limitHistoryTurns()` 已实现，但缺少后续层。

### 2.3 最终 Prompt 结构对比

**OpenClaw:**
```
[System prompt]
  身份、工具、技能
  [Inbound Meta] — channel/provider/chat_type (trusted)
  [Group Chat Context] — "你在 #general 频道"
  [Group Intro] — activation mode, lurking guidance

[Session messages]         ← agent session 历史（从 JSONL 加载，经过截断+压缩）
  (compaction summary)
  user / assistant / tool turns...

[Current user message]     ← channel history 嵌在这里
  [sender info]
  [thread starter / reply context]
  [Chat messages since your last reply]
    <history entries>
  [Current message]
    <actual message>
```

**Isotopes:**
```
[System prompt]
  SOUL.md + TOOLS.md + MEMORY.md

[Session messages]         ← 所有消息混在一起，统一截断
  user / assistant turns...
  (channel messages 也在这里面)

[Current user message]
  <message text>
```

---

## 3. 其他显著差异

### 3.1 消息去重

OpenClaw 使用 TTL 缓存（5 分钟，5000 条），key 为 `accountId:channelId:messageId`，防止 Discord gateway 重复推送同一条消息。

Isotopes: 无去重机制。

### 3.2 消息 Debounce（合并连发）

用户在短时间内连发多条消息时，OpenClaw 会 debounce 合并成一条 synthetic message：
- Key: `discord:${accountId}:${channelId}:${authorId}`
- 多条消息用 `\n` 拼接
- 跟踪 first/last messageId

Isotopes: 每条消息独立处理，连发 3 条就是 3 个独立的 agent 调用。

### 3.3 Thread 处理

| 特性 | OpenClaw | Isotopes |
|---|---|---|
| Thread 独立 session | 基于 thread channelId | 基于 thread binding |
| Thread starter 上下文 | 自动拉取首条消息，注入 system prompt | 无 |
| Forum channel 支持 | 识别 GuildForum/GuildMedia | 无 |
| autoThread 时排除 channel history | 防止无关上下文泄入新 thread | 无 |

### 3.4 Compaction（压缩摘要）

OpenClaw 在 token 接近 context window 上限时触发多阶段压缩：
- 自适应分块 (`computeAdaptiveChunkRatio`)
- 分阶段摘要 + 合并 (`summarizeInStages`)
- 质量审计 + 重试（最多 3 次）
- 结构化 fallback 摘要（Decisions, Open TODOs, Constraints, Identifiers）
- 摘要后截断 JSONL 文件防止无限增长

Isotopes: 依赖 pi-mono 的 compaction（在 2026-04-09 事故中发现未正确启用），无自建压缩逻辑。

### 3.5 Context Pruning（tool result 剪枝）

OpenClaw 通过 pi-mono 的 `"context"` 事件钩子实现两级剪枝：
- **Soft trim**（context 达到 30%）: tool result 只保留头尾各 1500 字符，中间替换为 `...`
- **Hard clear**（context 达到 50%）: tool result 整体替换为 `"[Old tool result content cleared]"`
- 最近 3 条 assistant 消息受保护
- 首条 user 消息前的内容受保护（保护 SOUL.md 等身份读取）

Isotopes: 无此机制。长 tool result 原样保留。

### 3.6 图片剪枝

OpenClaw 只保留最近 3 轮完成的 turn 中的图片，更早的替换为 `"[image data removed - already processed by model]"`。

Isotopes: 无此机制。

### 3.7 配置粒度

OpenClaw 的 `historyLimit` 支持多级覆盖：
```
全局 messages.groupChat.historyLimit
  → provider 级 channels.discord.historyLimit / dmHistoryLimit
    → 单个 DM channels.discord.dms.<userId>.historyLimit
```

Isotopes: 仅 transport 级一个值。

---

## 4. 差距总结

| 能力 | OpenClaw | Isotopes | 优先级 |
|---|---|---|---|
| Session history 按 user turn 截断 | ✅ | ✅ 已实现 | - |
| 截断后修复孤立 tool_result | ✅ | ❌ | 高 |
| Channel history 独立管理 | ✅ 纯文本注入 body | ❌ 混入 session | 高 |
| 消息去重 | ✅ TTL 缓存 | ❌ | 中 |
| 消息 debounce 合并 | ✅ | ❌ | 中 |
| Context pruning (tool result 剪枝) | ✅ 两级 | ❌ | 中 |
| Compaction (摘要压缩) | ✅ 多阶段自建 | ⚠️ 依赖 pi-mono | 低（已有基础能力） |
| Thread starter 上下文 | ✅ | ❌ | 低 |
| 图片剪枝 | ✅ | ❌ | 低（当前无图片场景） |
| 配置粒度（per-DM/per-channel） | ✅ | ❌ | 低 |
