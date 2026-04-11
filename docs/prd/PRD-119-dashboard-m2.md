# PRD-119: Dashboard M2 (Phase 1)

## Scope

**Phase 1 只做两个增强，不加新功能模块。**

### 1. Session 详情增强
- Session detail 页面显示消息内容（目前只有 messageCount）
- 消息列表：role, content preview, timestamp
- 分页或滚动加载（如果消息多）

### 2. Logs 增强
- Auto-scroll toggle（默认开启，新日志自动滚到底部）
- 日志级别颜色高亮（DEBUG=灰, INFO=默认, WARN=黄, ERROR=红）

**不做：** Auth, Agent Control, Config Editor

---

## 文件路径

```
src/api/routes.ts          — API 路由（需要加 session messages endpoint）
web/dashboard/app.js       — Dashboard 前端
web/dashboard/index.html   — Dashboard HTML
web/dashboard/styles.css   — Dashboard 样式
```

---

## 实现细节

### Session Messages API

```
GET /api/sessions/:id/messages
Response: { messages: [{ role, content, timestamp }] }
```

在 `src/api/routes.ts` 加 endpoint，读取 session store。

### 前端改动

**app.js:**
1. `renderSessionDetail()` — 加消息列表渲染
2. `toggleAutoScroll()` — auto-scroll 控制
3. Log 级别颜色 class

**styles.css:**
```css
.log-debug { color: #888; }
.log-info { color: inherit; }
.log-warn { color: #f0ad4e; }
.log-error { color: #d9534f; }
```

---

## 工作量

- API: ~30 行
- 前端: ~80 行
- 估计 1-2 小时
