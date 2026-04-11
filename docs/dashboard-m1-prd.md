# Dashboard M1 PRD — 只读管理面板

## 目标
为 Isotopes 提供 Web 管理界面，M1 实现只读功能，验证架构可行性。

## 技术方案
- **前端**: Vanilla HTML/JS/CSS（无构建步骤）
- **目录**: `web/dashboard/`
- **服务**: API server 静态服务 `/dashboard/*`
- **主题**: Dark theme

## M1 Scope

### API Endpoints（已有）
- `GET /api/status` — uptime, session count, cron count
- `GET /api/sessions` — session 列表
- `GET /api/sessions/:id` — session 详情 + history
- `GET /api/cron` — cron job 列表
- `GET /api/config` — 当前配置

### API Endpoints（需新增）
- `GET /api/agents` — agent 列表 + 状态
- `GET /api/logs?lines=100` — 最近 N 行日志

### 前端页面
1. **Dashboard 首页** (`/dashboard`)
   - Agent 状态卡片（名称、在线状态、uptime）
   - Session 统计（总数、活跃数）
   - Cron job 统计

2. **Session 列表** (`/dashboard/sessions`)
   - 表格：session ID, agent, channel, message count, last active
   - 点击查看详情

3. **Session 详情** (`/dashboard/sessions/:id`)
   - Transcript 浏览（role + content）
   - 元信息（创建时间、message count）

4. **Cron Jobs** (`/dashboard/cron`)
   - 表格：job 名称、schedule、上次运行、下次运行

5. **Logs** (`/dashboard/logs`)
   - 实时 tail 显示（polling 每 2s）
   - 最近 200 行

## M1 不做
- Config 编辑
- Workspace 文件编辑
- Agent/Session CRUD
- WebSocket 实时推送（用 polling 代替）

## 目录结构
```
web/
  dashboard/
    index.html      # SPA 入口
    app.js          # 路由 + 组件
    styles.css      # dark theme 样式
    components/     # 可复用组件（可选）
```

## 验收标准
1. 访问 `/dashboard` 能看到状态总览
2. 能浏览 session 列表和 transcript
3. 能看到 cron job 列表
4. 能看到实时日志
5. Dark theme，响应式布局
