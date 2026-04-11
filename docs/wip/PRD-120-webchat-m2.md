# PRD-120: WebChat M2 — Concurrent Sessions, Auth, Rate Limit

## Problem

WebChat M1 (#99) 提供了基础的 chat API，但缺少生产级功能：
1. **并发安全问题**：同一 session 可以同时收到多个请求，agent.prompt() 可能 race
2. **无认证**：任何人都能调用 API
3. **无限流**：可以被刷爆
4. **无清理**：idle session 永远堆积

## Solution

### 1. Session Lock / Queue

**问题**：两个请求同时 hit 同一个 sessionId，都调用 `agent.prompt()`，消息顺序和状态会乱。

**方案**：Per-session mutex lock

```typescript
// src/api/session-lock.ts
export class SessionLock {
  private locks = new Map<string, Promise<void>>();

  async acquire(sessionId: string): Promise<() => void> {
    // Wait for existing lock to release
    while (this.locks.has(sessionId)) {
      await this.locks.get(sessionId);
    }
    
    // Create new lock
    let releaseFn: () => void;
    const lockPromise = new Promise<void>(resolve => {
      releaseFn = resolve;
    });
    this.locks.set(sessionId, lockPromise);
    
    return () => {
      this.locks.delete(sessionId);
      releaseFn!();
    };
  }
}
```

**集成**：在 chat.ts 的 `/api/chat/message` 和 `/api/chat/stream` 开头 acquire lock，结束时 release。

### 2. API Key Auth

**方案**：简单 Bearer token，在 config 里配置

```yaml
# isotopes.yaml
api:
  auth:
    enabled: true
    keys:
      - "sk-webchat-xxx"  # 可以配多个
```

**实现**：
- 新建 `src/api/auth.ts` — 中间件函数
- 检查 `Authorization: Bearer <key>` header
- 匹配 `config.api.auth.keys` 数组中任一个
- 不匹配返回 401

**哪些路由需要 auth**：
- `/api/chat/*` — 需要（面向外部用户）
- `/api/status`, `/api/sessions`, `/api/logs` — 可选（dashboard 内部用）

简化方案：只给 `/api/chat/*` 加 auth，其他路由暂不加。

### 3. Rate Limit

**方案**：Per-IP sliding window

```typescript
// src/api/rate-limit.ts
export class RateLimiter {
  private windows = new Map<string, number[]>();
  
  constructor(
    private maxRequests: number = 60,
    private windowMs: number = 60_000,
  ) {}

  check(ip: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const timestamps = this.windows.get(ip) ?? [];
    
    // Remove expired timestamps
    const valid = timestamps.filter(t => now - t < this.windowMs);
    
    if (valid.length >= this.maxRequests) {
      const oldestValid = valid[0];
      const retryAfter = Math.ceil((oldestValid + this.windowMs - now) / 1000);
      return { allowed: false, retryAfter };
    }
    
    valid.push(now);
    this.windows.set(ip, valid);
    return { allowed: true };
  }

  // Periodic cleanup of stale entries
  cleanup(): void {
    const now = Date.now();
    for (const [ip, timestamps] of this.windows) {
      const valid = timestamps.filter(t => now - t < this.windowMs);
      if (valid.length === 0) {
        this.windows.delete(ip);
      } else {
        this.windows.set(ip, valid);
      }
    }
  }
}
```

**Config**：
```yaml
api:
  rateLimit:
    enabled: true
    maxRequests: 60
    windowMs: 60000
```

**Response**：429 Too Many Requests + `Retry-After` header

### 4. Idle Session Cleanup

**方案**：定时扫描，删除超过 TTL 的 session

```typescript
// 在 DefaultSessionStore 或新的 SessionCleaner 类
startCleanupTimer(ttlMs: number = 24 * 60 * 60 * 1000): void {
  setInterval(async () => {
    const sessions = await this.list();
    const now = Date.now();
    
    for (const session of sessions) {
      if (now - session.lastActiveAt.getTime() > ttlMs) {
        await this.delete(session.id);
      }
    }
  }, 60 * 60 * 1000); // Check hourly
}
```

**Config**：
```yaml
api:
  sessionTtl: 86400000  # 24 hours in ms
```

## File Changes

| File | Change |
|------|--------|
| `src/api/session-lock.ts` | **New** — SessionLock class |
| `src/api/auth.ts` | **New** — authMiddleware function |
| `src/api/rate-limit.ts` | **New** — RateLimiter class |
| `src/api/chat.ts` | Import + use lock, auth, rate limit |
| `src/api/middleware.ts` | Add helper for 401/429 responses |
| `src/core/session-store.ts` | Add cleanup timer method |
| `src/workspace/config-types.ts` | Add `api.auth`, `api.rateLimit`, `api.sessionTtl` |
| `src/api/*.test.ts` | Unit tests for each new component |

## Implementation Order

1. **session-lock.ts** + test — 独立，无依赖
2. **rate-limit.ts** + test — 独立，无依赖
3. **auth.ts** + test — 独立，需要 config types
4. **config-types.ts** — 加 api.* 字段
5. **chat.ts** — 集成上面三个
6. **session-store.ts** — cleanup timer
7. **Integration test** — E2E 验证

## Out of Scope (Future)

- OAuth / JWT — 复杂，暂不需要
- Per-user rate limit — 需要 user identity，暂不需要
- Session persistence across restart — DefaultSessionStore 已经有

## Questions

1. Dashboard API 是否也加 auth？（建议暂不，因为只在 localhost 监听）
2. Rate limit 是否区分 `/api/chat/message` vs `/api/chat/stream`？（建议统一计数）
