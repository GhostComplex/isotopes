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

维护 taskId → metadata mapping，支持按 session/channel 查询。

```typescript
// src/subagent/task-registry.ts
interface TaskInfo {
  taskId: string;
  sessionId: string;
  channelId: string;
  startedAt: Date;
}

class TaskRegistry {
  private tasks: Map<string, TaskInfo> = new Map();
  
  register(taskId: string, sessionId: string, channelId: string): void;
  unregister(taskId: string): void;
  get(taskId: string): TaskInfo | undefined;
  getBySession(sessionId: string): TaskInfo[];
  list(): TaskInfo[];
}
```

### 2. API Endpoints

```typescript
// GET /api/subagents
// List all running subagents
router.get("/subagents", (req, res) => {
  res.json({ tasks: taskRegistry.list() });
});

// DELETE /api/subagents/:taskId
// Cancel a specific subagent by taskId
router.delete("/subagents/:taskId", (req, res) => {
  const task = taskRegistry.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  subagentManager.cancel(req.params.taskId);
  taskRegistry.unregister(req.params.taskId);
  res.json({ cancelled: true, taskId: req.params.taskId });
});
```

### 3. Files to Change

| File | Change |
|------|--------|
| `src/subagent/task-registry.ts` | **新建** — taskId↔session mapping |
| `src/tools/subagent.ts` | 调用 registry.register/unregister |
| `src/api/routes/subagents.ts` | **新建** — GET list + DELETE cancel |
| `src/api/index.ts` | 注册 subagents routes |

### 4. Implementation Order

1. `task-registry.ts` + tests
2. `subagent.ts` — integrate registry
3. `api/routes/subagents.ts` — endpoints

### 5. Non-Goals (this PR)

- **Message trigger** — 不做。误触风险高
- Auto-abort timeout（已有 maxTurns 限制）
- `/abort` CLI 命令
- Feishu/Discord 特殊处理

## Test Plan

1. **Unit: TaskRegistry**
   - `register()` / `unregister()` lifecycle
   - `get()` / `getBySession()` / `list()` lookup

2. **Unit: API routes**
   - `GET /api/subagents` → returns task list
   - `DELETE /api/subagents/:taskId` → cancels + 200
   - `DELETE /api/subagents/:taskId` (not found) → 404

## Decisions

1. **Abort 后通知 parent agent** — 是，返回 "已取消" 消息
2. **需要 confirmation** — 否，直接执行
3. **Message trigger auto abort** — 否，只支持显式 API 调用
4. **API path** — `/api/subagents/:taskId` 而非 `/api/sessions/:id/subagent`
