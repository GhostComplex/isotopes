# PRD-124: Subagent Abort Capability

## Problem

无法从 parent channel 中断正在运行的 subagent。只能重启整个 Isotopes。

**场景：**
- Subagent 陷入死循环或执行错误任务
- 用户改变主意，想取消当前操作
- Subagent 执行时间过长

## Current State

**已有实现：**
- `AcpxBackend.cancel(taskId)` — SIGTERM → 5s → SIGKILL ✓
- `SubagentManager.cancel(taskId)` — 封装 backend.cancel() ✓
- `cancelSubagent()` — tool function ✓

**缺少：**
1. **Session↔Task mapping** — 不知道哪个 session 有哪个 running task
2. **API endpoint** — 无法通过 API abort

## Solution

### 1. Task Registry

维护 session → taskId mapping，让我们能从 session context 找到 running task。

```typescript
// src/subagent/task-registry.ts
class TaskRegistry {
  private tasks: Map<string, TaskInfo> = new Map();
  
  register(taskId: string, sessionId: string, channelId: string): void;
  unregister(taskId: string): void;
  getBySession(sessionId: string): TaskInfo | undefined;
  getByChannel(channelId: string): TaskInfo[];
  cancelBySession(sessionId: string): boolean;
}
```

### 2. API Endpoints

```typescript
// DELETE /api/sessions/:sessionId/subagent
// Cancel running subagent for this session
router.delete("/sessions/:sessionId/subagent", (req, res) => {
  const cancelled = taskRegistry.cancelBySession(req.params.sessionId);
  res.json({ cancelled });
});

// GET /api/subagents
// List all running subagents
router.get("/subagents", (req, res) => {
  res.json({ tasks: taskRegistry.list() });
});
```

### 3. Files to Change

| File | Change |
|------|--------|
| `src/subagent/task-registry.ts` | **新建** — session↔task mapping |
| `src/tools/subagent.ts` | 调用 registry.register/unregister |
| `src/api/routes/sessions.ts` | 添加 DELETE endpoint |
| `src/api/routes/subagents.ts` | **新建** — list running tasks |

### 4. Implementation Order

1. `task-registry.ts` — registry + tests
2. `subagent.ts` — integrate registry
3. `api/routes` — endpoints

### 5. Non-Goals (this PR)

- **Message trigger** — 不做。误触风险高（"stop doing X and start Y" 会被误判）
- Auto-abort timeout（已有 maxTurns 限制）
- `/abort <thread-id>` CLI 命令
- Feishu abort trigger

## Test Plan

1. **Unit: TaskRegistry**
   - `register()` / `unregister()` lifecycle
   - `getBySession()` / `getByChannel()` lookup
   - `cancelBySession()` calls backend.cancel()

2. **Integration**
   - API: `DELETE /api/sessions/:id/subagent` → task cancelled
   - API: `GET /api/subagents` → returns running tasks

## Decisions

1. **Abort 后通知 parent agent** — 是，返回 "已取消" 消息
2. **需要 confirmation** — 否，直接执行
3. **Message trigger auto abort** — 否，只支持显式 API 调用
