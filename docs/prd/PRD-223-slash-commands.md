# PRD-223: Slash Commands — /new, /reset, /compact + Daily Reset

## Issue

<https://github.com/GhostComplex/isotopes/issues/223>

## Problem

长期运行的 agent session 会累积大量历史，导致 context 膨胀、token 消耗增加、响应质量下降。用户需要能够手动或自动重置 session。

当前 Isotopes 只有 `/status`、`/reload`、`/model` 三个 slash command，缺少 session 生命周期管理命令。

## Goal

用户可以通过 chat 命令管理 session，daemon 支持按时间自动重置。

## Requirements

### P0 — Core Commands

1. **`/new`**
   - 清空当前 session 历史，开始新对话
   - 保留 session key 和 metadata（不创建新 session ID）
   - 回复确认：`✅ Session reset. Starting fresh.`

2. **`/reset`**
   - `/new` 的别名，行为相同
   - 用户习惯不同，两个都支持

3. **`/compact`**
   - 立即触发 context compaction（不等 safeguard 阈值）
   - 显示压缩前后 message 数量和估算 token 数
   - 回复示例：`✅ Compacted: 42 messages → 8 (est. 12k → 3k tokens)`

### P1 — Daily Reset

4. **Config 级别 daily reset**
   ```yaml
   agents:
     - id: fairy
       session:
         dailyReset:
           enabled: true
           time: "04:00"        # UTC or local (configurable timezone)
           timezone: "Asia/Shanghai"
   ```
   - 每天在指定时间自动清空所有活跃 session
   - 清空前保存最后 N 条 message 到 `memory/` 目录（可选）
   - 日志记录：`[session] Daily reset: cleared 3 sessions for agent fairy`

5. **`/sessions`**
   - 列出当前 agent 的所有活跃 session
   - 格式：
     ```
     Active sessions for fairy:
     • discord:fairy:guild:1234:chan:5678 — 15 msgs, last active 2m ago
     • feishu:fairy:group:abc — 3 msgs, last active 1h ago
     ```

### P2 — Advanced

6. **`/forget <n>`**
   - 删除最近 N 条 message（不做全量 reset）
   - 用于撤回误操作或清除错误上下文

7. **Session TTL**
   ```yaml
   session:
     ttl: 24h   # Auto-expire idle sessions
   ```

## Implementation Notes

### Slash Command 注册

扩展现有 `SlashCommandHandler`（`src/commands/slash-commands.ts`）：

```typescript
const KNOWN_COMMANDS = new Set([
  "status", "reload", "model",
  // New:
  "new", "reset", "compact", "sessions", "forget",
]);
```

### Session Reset 实现

```typescript
// SessionStore 需要新增方法：
interface SessionStore {
  // 现有
  get(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  // 新增
  clearMessages(id: string): Promise<void>;
  compact(id: string): Promise<CompactionResult>;
}
```

### Daily Reset 实现

利用现有 `CronScheduler` 注册内部 cron job：

```typescript
// 在 agent 启动时，如果配置了 dailyReset：
cronScheduler.register({
  name: `daily-reset-${agentId}`,
  expression: cronExprFromTime(config.dailyReset.time),
  agentId,
  action: { type: "session_reset" },
  internal: true,  // 不暴露给用户
});
```

## Acceptance Criteria

- [ ] `/new` 和 `/reset` 清空当前 session 历史
- [ ] `/compact` 立即触发 compaction 并返回统计
- [ ] `/sessions` 列出活跃 session
- [ ] daily reset 按配置时间执行
- [ ] 所有命令需要 admin 权限检查
- [ ] 单元测试覆盖各命令

## Dependencies

- 无外部依赖
- 基于现有 `SlashCommandHandler` + `SessionStore` + `CronScheduler`
