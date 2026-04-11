# PRD-120: WebChat M2 — Session Sidebar + 切换

## 问题

WebChat 只能看到当前 session。看不到历史 sessions，也看不到 ACP sessions（Discord 等）。

## 目标

Phase 1: **Session sidebar + 切换 + history 加载**（本 PR）
Phase 2: 跨 session 注入（defer，开新 issue）

## 现状

- `GET /api/sessions` 已经合并 ACP + chat sessions（PR #132）
- `GET /api/sessions/:id/messages` 已有
- WebChat 前端是 vanilla JS：`web/chat/app.js`、`index.html`、`styles.css`
- 无需后端改动

## 设计

### 前端改动

**1. HTML 结构** (`index.html`)
```
<div class="chat-wrapper">
  <aside class="session-sidebar">
    <div class="sidebar-header">Sessions</div>
    <div id="session-list" class="session-list"></div>
  </aside>
  <div class="chat-container">
    <!-- 现有内容 -->
  </div>
</div>
```

**2. Session 列表** (`app.js`)
- 启动时调用 `GET /api/sessions`
- 渲染列表：session name / ID，source badge（ACP/Chat），message count
- 当前 session 高亮
- 定时刷新（30s）与 Dashboard 对齐

**3. Session 切换逻辑**
- 点击 session → 调用 `GET /api/sessions/:id/messages`
- 清空 `messagesEl`，渲染 history
- 更新 `sessionId`，后续消息发到该 session
- 如果是 ACP session → 只读（Phase 1 不支持往 ACP session 发消息）

**4. New Chat**
- 现有 `newChat()` 保持不变
- 创建新 chat session，添加到列表顶部

### CSS 改动 (`styles.css`)
- `.chat-wrapper` — flex 容器
- `.session-sidebar` — 左侧 sidebar，width 240px
- `.session-item` — 列表项样式
- `.session-item.active` — 当前 session 高亮
- `.source-badge` — ACP/Chat 标签

## 边界条件

| 场景 | 处理 |
|------|------|
| 点击 ACP session | 加载 history，显示只读提示，禁用输入 |
| Session 被删除 | 刷新列表时移除，如果是当前 session 则自动新建 |
| 0 个 session | 显示空状态，引导 New Chat |

## 不做（Phase 2）

- 往 ACP session 发消息（跨 session 注入）
- Session 删除/rename UI
- Session 搜索/过滤

## 文件变更

| 文件 | 改动 |
|------|------|
| `web/chat/index.html` | 添加 sidebar 结构 |
| `web/chat/app.js` | 添加 session list/switch 逻辑 |
| `web/chat/styles.css` | 添加 sidebar 样式 |

## 测试

- [ ] 启动后显示 session 列表
- [ ] 点击 session 加载 history
- [ ] 切换 session 后发消息到正确 session
- [ ] ACP session 显示只读提示
- [ ] New Chat 创建新 session 并添加到列表
