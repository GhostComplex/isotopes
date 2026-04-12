# PRD-262: TUI — Interactive Terminal Chat + CLI Management Commands

## Issue

<https://github.com/GhostComplex/isotopes/issues/262>

## Problem

在没有 GUI 的 Linux VM（或任何 headless 环境）上，用户无法使用 WebChat 与 agent 交互。需要：
1. **TUI** — 终端内的交互式聊天界面，对标 WebChat 的所有能力
2. **CLI commands** — 一次性管理命令，用于运维和脚本

## Goal

`isotopes tui` 提供完整的终端聊天体验，`isotopes <command>` 提供所有管理操作。

---

## Part 1: TUI — 交互式终端聊天

### 1.1 核心功能

| 功能 | 说明 |
| --- | --- |
| 实时聊天 | 输入 prompt → streaming 输出 → 支持多轮对话 |
| Agent 选择 | 启动时选择 agent 或 `--agent <id>` 指定 |
| Session 管理 | 列出 / 切换 / 新建 / 删除 session |
| Markdown 渲染 | 代码块语法高亮、表格、列表 |
| 工具调用展示 | 显示 tool_use 状态（thinking → calling → result） |
| 历史回看 | 加载已有 session 的历史消息 |

### 1.2 布局

```
┌─────────────────────────────────────────────────────┐
│ 🔬 Isotopes TUI  │ Agent: fairy  │ Model: opus-4.6  │
├──────────┬──────────────────────────────────────────┤
│ Sessions │                                          │
│          │  [assistant] Hello! How can I help?       │
│ > #main  │                                          │
│   #dev   │  [you] 看一下 PR #42 的改动              │
│   #ops   │                                          │
│          │  [assistant] 正在查看...                  │
│          │  🔧 exec: gh pr view 42                  │
│          │                                          │
│          │  PR #42 的改动如下：                      │
│          │  ...                                      │
├──────────┴──────────────────────────────────────────┤
│ > 输入消息...                              [Enter ⏎]│
└─────────────────────────────────────────────────────┘
```

- **左侧 sidebar**：session 列表，按 agent 分组，高亮当前 session
- **主区域**：聊天消息，支持滚动
- **底部**：输入框，支持多行（Shift+Enter）
- **顶部 status bar**：agent 名、model、连接状态

### 1.3 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+N` | 新建 session |
| `Ctrl+T` / `Tab` | 切换 session（sidebar 导航） |
| `Ctrl+D` | 删除当前 session |
| `Ctrl+L` | 清屏 |
| `Ctrl+C` | 取消当前生成 / 退出 |
| `Ctrl+K` | 命令面板（类似 VS Code） |
| `↑` / `↓` | 历史消息滚动 |
| `PageUp` / `PageDown` | 快速滚动 |

### 1.4 内置命令（在输入框中）

| 命令 | 功能 |
| --- | --- |
| `/new` | 新建 session |
| `/switch <name>` | 切换 session |
| `/sessions` | 列出 session |
| `/model <name>` | 切换 model |
| `/status` | 查看状态 |
| `/compact` | 触发 compaction |
| `/agent <id>` | 切换 agent |
| `/quit` | 退出 TUI |

### 1.5 技术选型

**推荐：Ink (React for CLI)**

理由：
- TypeScript 原生支持，与 Isotopes 技术栈一致
- 声明式 UI，组件化开发
- 支持 flexbox 布局
- 社区活跃，生态丰富
- 支持 streaming 更新

```json
{
  "dependencies": {
    "ink": "^5.0.0",
    "ink-text-input": "^6.0.0",
    "ink-spinner": "^5.0.0",
    "ink-syntax-highlight": "^2.0.0",
    "cli-markdown": "^3.0.0"
  }
}
```

**备选：blessed / neo-blessed**
- 更底层，更灵活
- 但 API 老旧，TypeScript 支持弱

### 1.6 API 接入

TUI 通过 HTTP API 与 daemon 通信，复用现有 REST 端点：

| TUI 功能 | API 端点 |
| --- | --- |
| 发送消息 | `POST /api/chat/stream`（SSE） |
| 获取历史 | `GET /api/chat/history?sessionId=` |
| 列出 session | `GET /api/sessions` |
| 删除 session | `DELETE /api/sessions/:id` |
| 查看状态 | `GET /api/status` |
| 列出 agent | `GET /api/chat/agents` |
| 查看日志 | `GET /api/logs` |
| 查看 usage | `GET /api/usage` |

如果 daemon 未运行，TUI 提示 `isotopes start` 先启动。

---

## Part 2: CLI Management Commands

### 2.1 Agent 管理

```bash
isotopes agent list                    # 列出所有 agent
isotopes agent info <id>               # 查看 agent 详情（model/workspace/bindings）
isotopes agent add <id>                # 交互式添加 agent
isotopes agent remove <id>             # 删除 agent（需确认）
```

实现方式：读写 `~/.isotopes/config.yaml`，调用 `PUT /api/config` 触发 hot-reload。

### 2.2 Session 管理

```bash
isotopes sessions list                 # 列出所有活跃 session
isotopes sessions show <id>            # 查看 session 详情和最近 N 条消息
isotopes sessions delete <id>          # 删除 session
isotopes sessions reset [--agent <id>] # 清空指定 agent 的所有 session
```

### 2.3 Model 管理

```bash
isotopes model                         # 查看当前默认 model
isotopes model list                    # 列出所有可用 model
isotopes model set <model>             # 切换默认 model
isotopes model set <model> --agent <id> # 切换指定 agent 的 model
```

### 2.4 一次性聊天

```bash
isotopes chat "你的 prompt"             # 发送消息并等待回复（非交互式）
isotopes chat --agent fairy "看下 PR"   # 指定 agent
isotopes chat --stream "解释一下"       # streaming 输出
isotopes chat -f prompt.md             # 从文件读取 prompt
```

用途：脚本集成、CI/CD、快速提问。

### 2.5 Cron 管理

```bash
isotopes cron list                     # 列出定时任务
isotopes cron add --name "daily" \
  --expression "0 9 * * *" \
  --agent fairy \
  --action prompt \
  --message "早间汇报"                 # 添加定时任务
isotopes cron remove <id>              # 删除
isotopes cron enable <id>              # 启用
isotopes cron disable <id>             # 禁用
```

### 2.6 日志 & 调试

```bash
isotopes logs                          # tail 最近 100 行日志
isotopes logs -f                       # follow 模式
isotopes logs -n 500                   # 指定行数
isotopes usage                         # token 消耗统计
isotopes usage --agent fairy           # 指定 agent
```

### 2.7 Config 管理

```bash
isotopes config show                   # 查看当前 config（脱敏显示）
isotopes config edit                   # 用 $EDITOR 打开 config 文件
isotopes config validate               # 校验 config 格式
isotopes config path                   # 显示 config 文件路径
```

### 2.8 健康检查

```bash
isotopes doctor                        # 全面检查
```

检查项：
- Daemon 是否运行
- API 是否可达
- Discord bot token 是否有效（尝试连接）
- Provider API 是否可达（发送 ping）
- Workspace 目录是否存在
- Config 是否合法
- Node.js 版本是否 ≥ 20
- 可选依赖检查（claude CLI、acpx 等）

输出示例：
```
🔬 Isotopes Doctor

✅ Daemon running (pid 12345, uptime 2d 3h)
✅ API reachable (http://127.0.0.1:7600)
✅ Discord connected (2 bots online)
✅ Provider reachable (copilot-proxy)
✅ Workspace exists (~/.isotopes/workspace/fairy)
✅ Config valid
✅ Node.js v24.14.0
⚠️  claude CLI not found (subagent will not work)
⚠️  acpx not found (ACP protocol unavailable)

7/9 checks passed
```

---

## Priority

### P0（MVP — Linux VM 可用）
- `isotopes tui` — 基本聊天 + streaming
- `isotopes chat "prompt"` — 一次性聊天

### P1（完整体验）
- TUI session 切换、sidebar、快捷键
- agent/session/model CLI 命令
- `isotopes logs` + `isotopes doctor`

### P2（锦上添花）
- cron CLI 命令
- config CLI 命令
- usage 统计
- TUI 命令面板（Ctrl+K）

## Acceptance Criteria

- [ ] `isotopes tui` 启动交互式界面
- [ ] TUI 中能发送消息并看到 streaming 回复
- [ ] TUI 中能切换 session
- [ ] `isotopes chat "hello"` 返回回复
- [ ] `isotopes agent list` 列出 agent
- [ ] `isotopes sessions list` 列出 session
- [ ] `isotopes logs` 输出日志
- [ ] `isotopes doctor` 输出健康检查结果
- [ ] 所有 CLI 命令支持 `--help`
- [ ] 所有 CLI 命令支持 `--json` 输出（方便脚本使用）

## Dependencies

- **ink** ^5.0.0（TUI 框架）
- 现有 REST API（`/api/chat/*`、`/api/sessions`、`/api/status` 等）
- Node.js ≥ 20
