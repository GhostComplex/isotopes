# WebChat Frontend Design — Issue #98

## Goal
提供一个简单的 Web 界面，让用户可以直接和 Isotopes agent 对话，无需 Discord 或飞书。

## Scope (M1)
- 单页面聊天界面
- 与一个 agent 的单会话
- 发送消息 → 接收回复
- 消息历史显示

## Architecture

### Files
```
web/chat/
├── index.html    — 入口页面
├── styles.css    — 样式
└── app.js        — 前端逻辑 (vanilla JS)

src/api/
├── chat.ts       — WebChat API routes (POST /api/chat/message, GET /api/chat/history)
├── static.ts     — 添加 serveChat() 或扩展为通用 serveStatic()
```

### API Endpoints

#### POST /api/chat/message
发送消息到 agent，返回回复。

Request:
```json
{
  "agentId": "fairy",
  "message": "Hello!"
}
```

Response:
```json
{
  "reply": "Hi there!",
  "sessionId": "chat-123"
}
```

#### GET /api/chat/history?sessionId=xxx
获取会话历史。

Response:
```json
{
  "messages": [
    { "role": "user", "content": "Hello!", "timestamp": "..." },
    { "role": "assistant", "content": "Hi there!", "timestamp": "..." }
  ]
}
```

### Session Management
- 首次访问分配 sessionId，存 localStorage
- Session 复用现有 AcpSessionManager
- Agent 选择：初版用 config 中第一个 agent，后续可扩展为下拉选择

### UI Design
- 简洁聊天界面，类似 ChatGPT 风格
- 左侧可选 agent 列表（M2）
- 消息气泡：用户右侧，assistant 左侧
- 输入框底部，Enter 发送

## Dependencies
- AcpSessionManager — 复用 session 管理
- Chat engine (已有) — 处理消息

## Non-goals (M1)
- 认证 (M2)
- 多 agent 切换 (M2)
- Rate limiting (M2)
- 并发安全 (M2)
- Streaming response

## Implementation Steps
1. 创建 `src/api/chat.ts` — 路由处理
2. 扩展 `src/api/static.ts` — 支持 /chat 路由
3. 创建 `web/chat/` 前端文件
4. 更新 `src/api/server.ts` — 集成 chat routes
5. 测试
