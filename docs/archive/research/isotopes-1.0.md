# Isotopes 迁移缺口分析

基于 OpenClaw 与 Isotopes 的源码、配置和实际工作模式对比，本文档梳理了将当前 manager-agent 工作流迁移到 Isotopes 所需补齐的关键能力，并按优先级给出迁移路线建议。

---

## 1. 摘要

Isotopes 已经具备多 Agent、workspace、Discord/Feishu transport、skills、session persistence、cron、REST API、sandbox、daemon、config hot-reload 等大量基础设施，整体架构已经足够接近 OpenClaw。

但如果要完整承接当前的 manager-agent 工作流，尤其是与 Tachikoma 的协作模式，仍存在几类关键缺口：

- **P0：Session Tools / Announce / Heartbeat**
- **P1：多账号、多身份、权限与上下文能力**
- **P2：体验层能力补齐**

其中最核心的迁移阻塞点是：

1. 缺少完整的 **session 管理工具集**
2. 缺少 **subagent 异步完成后的 announce 机制**
3. 缺少 **heartbeat / 周期性唤醒机制**

---

## 2. 实现对比

### 2.1 Isotopes 已有能力（与 OpenClaw 大致对齐）

| 能力 | Isotopes 实现 | OpenClaw 对应 |
| --- | --- | --- |
| 多 Agent 定义 | `agents[]` in YAML | `agents.list[]` |
| Agent -> Channel 路由 | `bindings[]` (`channel/accountId/peer`) | `bindings[]` 相同模式 |
| Per-agent workspace | `workspacePath` per agent | `workspace` per agent |
| Per-agent session store | `sessionStoreForAgent(agentId)` | `~/.openclaw/agents/<id>/sessions` |
| Workspace 文件加载 | `SOUL.md` / `USER.md` / `TOOLS.md` / `AGENTS.md` / `MEMORY.md` | 相同 |
| Discord transport | 支持 DM + guild + thread | 支持 |
| Feishu transport | WebSocket | 支持 |
| Session key 格式 | `{transport}:{botId}:{scope}:{scopeId}:{agentId}` | `agent:<id>:main` / `agent:<id>:subagent:<uuid>` |
| Context compaction | `safeguard` / `aggressive` / `off` | 相同 |
| Subagent spawn | `spawn_subagent` -> Claude / Codex / Gemini | `sessions_spawn` -> Claude Code / Codex / ACP harness |
| Discord thread 流式输出 | `DiscordSink + thread` | 支持 |
| Thread binding | `ThreadBindingManager + auto-unbind` | 支持 |
| Skills 系统 | `SkillLoader + SKILL.md parser + prompt 注入` | 相同格式 |
| Cron 定时任务 | `CronScheduler + config-level cron` | 支持 |
| REST API | `sessions/cron/config/status` endpoints | 支持 |
| Sandbox (Docker) | `off / non-main / all` | 支持 |
| Daemon | `launchd/systemd start/stop/restart/service` | `openclaw gateway` |
| Config hot-reload | `ConfigReloader + file watcher` | 支持 |
| Git / GitHub tools | `git.ts + github.ts` | `gh` CLI（通过 exec） |

### 2.2 结论

Isotopes 并不是“从零开始”，而是已经有了相当完整的系统骨架。迁移的核心问题不是基础设施缺失，而是 **manager-agent 工作流所依赖的高阶 session 能力和协作机制还没有补齐**。

---

## 3. P0 缺失：迁移阻塞项

这部分能力如果不做，迁移后无法维持当前工作模式。

### 3.1 Session Tools（最重依赖）

OpenClaw 为 agent 提供了一整套 session 管理工具，这些能力构成了日常工作的核心闭环。

| Tool | 用途 | Isotopes 状态 |
| --- | --- | --- |
| `sessions_list` | 列出可见 session，发现目标 | 缺失 |
| `sessions_history` | 读取其他 session 的 sanitized 历史 | 缺失 |
| `sessions_send` | 向另一个 session 发消息 | 缺失 |
| `sessions_spawn` | spawn 子 agent，能力强于 `spawn_subagent` | 部分具备，仅有 AcpxBackend |
| `sessions_yield` | 挂起等待 subagent 结果 | 缺失 |
| `session_status` | 查看当前 session 状态 / usage / model | 缺失 |
| `subagents` | `list` / `kill` / `steer` 已 spawn 子 agent | 缺失 |

**为什么是 P0：**

- 当前工作模式是：`spawn subagent -> 等结果 -> review -> steer/kill`
- 如果没有 `sessions_spawn + sessions_history + subagents`，manager-agent 无法管理团队式工作流
- 与 Tachikoma 的协作也依赖跨 session 通信，至少需要 `sessions_send` 或等价机制

### 3.2 Announce 机制

OpenClaw 中 subagent 完成后，会自动 announce 结果到请求者所在的 chat channel。  
Isotopes 当前的 `spawn_subagent` 只会同步返回 tool call 结果，缺少以下能力：

- 异步 announce：subagent 完成后主动推送通知到 parent session
- completion delivery routing：找回请求者的 channel / thread
- announce payload normalization：统一封装 `status/runtime/cost/sessionKey`

**为什么是 P0：**

没有 announce，subagent 只能同步阻塞等待，无法并行化工作，也无法形成真正的多 agent 协作体验。

### 3.3 Heartbeat / 周期性唤醒

OpenClaw 有 heartbeat 机制，可以定期唤醒 agent，并结合 `HEARTBEAT.md` 进行 proactive 工作，如：

- 检查 email / calendar / 项目状态
- 做 memory 维护
- 更新 `MEMORY.md`

Isotopes 当前状态：

- Heartbeat poll：缺失
- Cron：已具备，但 cron 是独立 session，不继承 main session 上下文

**为什么重要：**

cron 虽然能覆盖“定时执行”这个动作，但无法覆盖 heartbeat 的“维持主会话连续上下文”能力。

### 3.4 DM Scope 隔离

OpenClaw 支持 `dmScope` 配置，用于定义 DM session 的隔离粒度：

- `main`：所有 DM 共享一个 session
- `per-peer`：每个 peer 一个 session
- `per-channel-peer`：每个 channel + peer 一个 session（推荐）

Isotopes 当前的 session key 形式：

```text
discord:{botId}:dm:{userId}:{agentId}
```

它基本等效于 `per-channel-peer`，这部分问题不大，但仍缺少：

- `session.identityLinks`：跨 channel 关联同一用户身份
- `session.reset`：支持 `daily / idle / manual` reset 策略

---

## 4. P1 缺失：迁移后体验明显降级

### 4.1 多 Account 支持

OpenClaw 支持一个 channel 下挂多个 account（多个 Discord bot token），每个 account 绑定不同 agent。  
Isotopes 当前 Discord transport 只支持一个 bot token。

这会直接影响以下使用方式：

- `discord.accounts.major.token -> agent major`
- `discord.accounts.tachikoma.token -> agent tachikoma`

当前 workaround 只能依赖同一 bot 下的 `@mention` 路由，无法让每个 agent 拥有真正独立的 bot 身份。

### 4.2 Per-agent Auth Profile 隔离

OpenClaw 支持每个 agent 使用独立的 `auth-profiles.json`：

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Isotopes 目前使用全局 provider config，无法做到 per-agent credential 隔离。

### 4.3 Tool Allow / Deny Policy

OpenClaw 支持细粒度的 per-agent tool policy：

```json
{
  "tools": {
    "allow": ["read", "exec"],
    "deny": ["write", "browser"]
  }
}
```

Isotopes 当前只有：

- `tools.cli`
- `tools.fs.workspaceOnly`

尚未具备 per-tool allow / deny 能力。（Issue #117 已开）

### 4.4 Context Engine

OpenClaw 提供 pluggable context engine，用于控制 system prompt assembly、cache boundary 和 dynamic context injection。  
Isotopes 当前使用硬编码的 `buildSystemPrompt()` + `buildToolGuardPrompt()`，还没有 plugin 机制。

### 4.5 Memory Search（QMD）

OpenClaw 可配置 memory backend（如 qmd）用于 session transcript 搜索，包括 cross-agent memory search。  
Isotopes 当前只有文件级 `MEMORY.md` 加载。

### 4.6 Web Tools

OpenClaw 提供 `web_search`、`web_fetch` 等 web 工具。  
Isotopes 当前未提供对应能力。（Issue #116 已开）

### 4.7 read / write / edit / exec 工具差距

| OpenClaw Tool | Isotopes 对应 | 差距 |
| --- | --- | --- |
| `read`（offset/limit/image） | `read_file` | 无 `offset/limit`，无 image 支持 |
| `write` | `write_file` | 基本对齐 |
| `edit`（精确文本替换） | 无 | 完全缺失 |
| `exec`（background/yieldMs/pty） | `shell` | 无 background / pty / timeout 控制 |
| `process`（poll/log/send-keys） | 无 | 完全缺失 |
| `web_search` | 无 | Issue #116 |
| `web_fetch` | 无 | Issue #116 |

---

## 5. P2 缺失：Nice to Have

这部分不会阻塞迁移，但会影响整体体验与产品完整度。

- Slash commands：`/new`、`/reset`、`/stop`、`/focus`、`/unfocus`、`/model`
- Presence 管理（agent online/offline 状态）
- Broadcast groups
- Nested subagents（depth > 1）
- Auto-archive subagent sessions
- Security audit（openclaw security audit）
- Agent wizard（openclaw agents add）
- Channel status probe（openclaw channels status --probe）
- Reply / reaction support（引用回复、emoji reactions）
- Group chat metadata injection（sender info、chat history 作为 untrusted context）
- Signal / WhatsApp / Telegram / iMessage transports
- 更多 ACP harness（Cursor、Copilot、Kimi、Qwen；Isotopes 已声明 type 但尚未实现）

---

## 6. Config 对比速查

| Config Key | OpenClaw | Isotopes | 差异 |
| --- | --- | --- | --- |
| Agent 定义 | `agents.list[]` | `agents[]` | 名称不同，结构类似 |
| Agent defaults | `agents.defaults.*` | 顶层 `provider/tools/compaction` | OpenClaw 的 defaults 命名空间更清晰 |
| Bindings | `bindings[]` | `bindings[]` | 已对齐 |
| Discord | `channels.discord.accounts.*` | `discord.*` | OpenClaw 支持多 account |
| DM scope | `session.dmScope` | 无 | 缺失 |
| Session reset | `session.reset.*` | 无 | 缺失 |
| Identity links | `session.identityLinks` | 无 | 缺失 |
| Subagent config | `agents.defaults.subagents.*` | `acp.subagent.*` | OpenClaw 更丰富，如 `maxSpawnDepth/maxChildren/archiveAfterMinutes` |
| Heartbeat | `agents.defaults.heartbeat.*` | 无 | 缺失 |
| Memory backend | `memory.backend` | 无 | 缺失 |
| Tool policy | `agents.list[].tools.allow/deny` | 无 | Issue #117 |
| Sandbox | `agents.list[].sandbox.*` | `agents[].sandbox.*` | 已对齐 |
| Skills | `agents.defaults.skills / per-agent` | workspace-level discovery | OpenClaw 有 per-agent allowlist |

---

## 7. 与当前工作模式的关键差距

下表从日常使用角度总结 OpenClaw 与 Isotopes 的实际差异。

| 日常操作 | OpenClaw 能力 | Isotopes 状态 |
| --- | --- | --- |
| Spawn coding agent 做任务 | `sessions_spawn` -> 后台运行 -> announce 结果 | `spawn_subagent` 为同步阻塞 |
| 并行 spawn 多个 subagent | `sessions_spawn × N` -> 各自 announce | 只能串行 |
| 查看 subagent 进度 | `subagents list/log/info` | 缺失 |
| Kill 卡住的 subagent | `subagents kill` | 缺失 |
| 向 subagent 追加指令 | `subagents steer` | 缺失 |
| 读取其他 session 历史 | `sessions_history` | 缺失 |
| 跨 session 发消息 | `sessions_send` | 缺失 |
| 定期 proactive 检查 | `Heartbeat + HEARTBEAT.md` | 缺失 |
| 更新 memory 文件 | `write/edit` tools | 仅有 `write_file`，无 `edit` |
| 执行 git/gh 命令 | `exec`（background/pty） | `shell` 仅支持简单 exec，且 30s timeout |
| 与 Tachikoma 协作 | 不同 agent、不同 workspace、@mention 路由 | 多 agent 有基础，但缺 session tools |

---

## 8. 迁移路线建议

### Phase 1：最小可用

目标：先让 manager-agent 工作流能跑起来。

优先补齐：

1. `sessions_spawn`（异步）+ `sessions_history` + `subagents`（`list/kill/steer`）
2. announce 机制：subagent 完成后 push 到 parent channel
3. `edit` tool（精确文本替换，coding 必需）
4. `exec` 增强（background mode、timeout 控制、stdout/stderr streaming）
5. `web_search + web_fetch`（Issue #116）

### Phase 2：多 Agent 协作

目标：恢复多身份、多 agent 协作体验。

优先补齐：

1. Multi-account Discord（每个 agent 独立 bot token）
2. Per-agent auth profiles
3. Tool allow / deny policy（Issue #117）
4. Session reset 策略（`daily/idle/manual`）
5. Heartbeat 机制

### Phase 3：体验对齐

目标：逐步拉近到 OpenClaw 的完整使用体验。

优先补齐：

1. Group chat metadata injection
2. Reply / reaction support
3. Slash commands
4. Memory search

---

## 9. 结论

Isotopes 作为底层平台已经具备很强的基础能力，但对当前 manager-agent 工作流来说，真正缺的不是 transport、workspace 或基础多 agent，而是：

- **session orchestration**
- **subagent async workflow**
- **跨 session 协作**
- **主动式上下文维护**

如果优先补齐 `sessions_spawn / sessions_history / subagents / announce / heartbeat`，Isotopes 就能从“基础设施接近 OpenClaw”进一步迈向“工作流可真正迁移”。
