# Bug: Thread Binding 在重启后未清理导致对话卡在 Thread

## 问题描述

Isotopes 在重启后可能仍然被绑定到旧的 Discord thread，导致消息被错误路由。

## Root Cause 分析

### 触发场景
1. Isotopes spawn Claude Code subagent 到 thread
2. Subagent 被强制中断（例如进程重启）
3. Thread binding 没有被清理
4. Isotopes 重启后继续被 bind 到 thread
5. 消息路由到 thread 而不是 parent channel

### 技术原因
1. **Thread bindings 存储在内存中** - 进程重启后丢失
2. **Auto-unbind 依赖 subagent 正常结束** - 强制中断时不会触发
3. **没有 stale binding 清理机制** - 重启后不会检查哪些 thread 应该被解绑

## 解决方案

### 方案 A: 启动时清理 stale bindings
```typescript
// 在 DiscordTransport 启动时
async start() {
  // 清理所有 thread bindings
  this.threadBindings.clear();
  // 或者从持久化存储加载并验证
}
```

### 方案 B: Thread binding 持久化
```typescript
// 将 thread bindings 存储到文件或数据库
// 重启时加载并验证每个 binding 是否仍然有效
```

### 方案 C: 添加手动 unbind 命令
```bash
# CLI 命令
isotopes unbind-thread <thread-id>
# 或 Discord 命令
/isotopes unbind
```

## 相关文件

- `src/core/thread-bindings.ts` - ThreadBindingManager
- `src/transports/discord.ts` - Discord transport
- `src/subagent/discord-sink.ts` - DiscordSink (auto-unbind 逻辑)

## 优先级

**Medium** - 影响用户体验，但可以通过重启解决

## 状态

- [x] Root cause 已定位
- [ ] 修复方案已确认
- [ ] PR 已提交
- [ ] 测试通过
- [ ] 已部署验证
