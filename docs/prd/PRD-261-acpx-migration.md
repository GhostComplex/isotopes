# PRD-261: Migrate Subagent Backend to Real acpx ACP Protocol

## Issue

<https://github.com/GhostComplex/isotopes/issues/261>

## Problem

当前 `AcpxBackend`（`src/subagent/acpx-backend.ts`）名字有误导性 — 它直接 spawn `claude -p --output-format stream-json`，不走 ACP（Agent Client Protocol）。

具体问题：
- **只有 Claude 能用** — 虽然 `ACPX_AGENTS` 声明了 8 个 agent（claude/codex/gemini/cursor/copilot/opencode/kimi/qwen），但 spawn 时硬编码 `spawn("claude", args)`
- **不走 ACP 协议** — 没有 `session/new`、`prompt/submit`、`session/load` 等 ACP session 管理
- **无法 resume session** — 每次都是新进程，没有 session 持久化
- **无法 steer** — 没有 `prompt/submit` 到已有 session 的能力

## Goal

用真正的 acpx binary 替换直接 spawn claude，支持多 agent + session 管理 + steer。

## Background

### OpenClaw 的 acpx 实现

OpenClaw 内置了 `acpx` v0.5.2（`@openclaw/acpx`），每个 agent 有对应的 ACP adapter：

| Agent | 启动命令 |
| --- | --- |
| claude | `npx @agentclientprotocol/claude-agent-acp@<ver>` |
| codex | `npx @zed-industries/codex-acp@<ver>` |
| gemini | `gemini --acp` |
| cursor | `cursor-agent acp` |
| copilot | `copilot --acp --stdio` |
| opencode | `npx opencode-ai acp` |

### 验证结果

在当前机器上已验证 `acpx claude exec` 能正常工作：

```
$ acpx claude exec "reply with exactly: ACPX_CLAUDE_OK"
[client] initialize (running)
[client] session/new (running)
ACPX_CLAUDE_OK
[done] end_turn
```

## Requirements

### P0 — Core Migration

1. **替换 spawn 方式**
   - 从 `spawn("claude", ["-p", "--output-format", "stream-json", ...])` 
   - 改为 `spawn("acpx", [agent, "exec", ...])` 或使用 acpx 的 programmatic API
   - acpx binary 可以作为 dependency 引入，或要求用户全局安装

2. **多 agent 支持**
   - 至少支持 `claude` + `codex`
   - 根据 `ACPX_AGENTS` 配置动态选择 agent
   - 每个 agent 的 ACP adapter 自动解析（acpx 内部处理）

3. **事件流解析**
   - ACP 协议的事件格式与 `claude -p --stream-json` 不同
   - 需要适配 ACP 的 JSON-RPC notification（`session/update`、`prompt/progress` 等）
   - 保持现有 `DiscordSink` streaming 能力

4. **cancel/abort**
   - 使用 ACP 的 `prompt/cancel` 替代 kill process
   - 更优雅的取消，允许 agent 清理

### P1 — Session Management

5. **Session 持久化**
   - 使用 `acpx <agent> prompt` 替代 `acpx <agent> exec` 实现 persistent session
   - subagent 的 session 可以跨多次调用保持
   - 支持 `acpx <agent> sessions list/new/close`

6. **Steer 能力**
   - 向正在运行的 subagent session 发送新指令
   - 对应 OpenClaw 的 `subagents(action=steer)`

7. **Session resume**
   - daemon 重启后，能恢复之前的 subagent session
   - 通过 `acpx <agent> sessions ensure --name <name>` 实现

### P2 — Advanced

8. **Agent 自动发现**
   - 检测本机已安装的 agent（`claude --version`、`codex --version` 等）
   - 在 config 中配置可用 agent 列表

9. **Per-agent config**
   ```yaml
   subagent:
     defaultAgent: claude
     agents:
       claude:
         permissionMode: approve-all
         model: claude-opus-4.6
       codex:
         model: codex-mini
   ```

## Implementation

### 方案 A：Shell-out to acpx binary

最简方案，直接调用 acpx CLI：

```typescript
// Before:
const proc = spawn("claude", ["-p", "--output-format", "stream-json", ...]);

// After:
const proc = spawn("acpx", [agent, "exec", prompt], {
  cwd: options.cwd,
  env: { ...process.env },
});
```

优点：零 adapter 代码，acpx 处理所有协议细节。
缺点：依赖 acpx binary，事件解析需要适配。

### 方案 B：引入 acpx 作为 npm dependency

```json
{
  "dependencies": {
    "acpx": "^0.5.0"
  }
}
```

直接 import acpx 的 programmatic API（如果暴露了的话）。

优点：类型安全，不走 CLI 解析。
缺点：acpx 可能没有 public programmatic API。

### 推荐

**方案 A**（shell-out）优先。acpx 作为 peerDependency 或 optionalDependency，文档说明安装方式。如果后续 acpx 暴露了 programmatic API，再迁移到方案 B。

### 事件流适配

acpx CLI 的 stdout 输出格式需要分析。初步观察：
- 进度信息走 stderr（`[client] initialize (running)`）
- 内容输出走 stdout（直接是 text）
- `exec` 模式是 one-shot，没有 session 状态

需要测试 `--format json` 或其他输出格式是否能拿到结构化事件。

## Acceptance Criteria

- [ ] `spawn_subagent` 默认使用 acpx binary
- [ ] `spawn_subagent` 支持 `agent: "claude"` 和 `agent: "codex"`
- [ ] DiscordSink streaming 正常工作
- [ ] cancel/abort 通过 ACP 协议或 process kill 正常工作
- [ ] 回退机制：如果 acpx 不可用，fallback 到直接 `claude -p`
- [ ] 测试覆盖新旧两种 backend

## Dependencies

- `acpx` binary（peerDependency 或全局安装）
- 各 agent 的 ACP adapter（由 acpx 自动解析 via npx）
