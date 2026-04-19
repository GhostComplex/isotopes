# PRD：将 Major 与 Tachikoma 从 OpenClaw 迁移到 Isotopes

> **Note (2026-04, #392):** Discord 配置已从顶层 `discord:` 块合并到 `channels.discord.accounts.<id>` 下。下文的 yaml 示例为旧 shape，仅作历史参考；当前 shape 见 `isotopes.example.yaml`。

## 1. 文档概述

### 1.1 背景

当前 Major 与 Tachikoma 的核心工作流运行在 OpenClaw 上，已经形成稳定使用习惯，包括：

- 多 Discord Bot 独立身份
- 每个 Agent 独立 Workspace / Memory / Skills
- 通过 Slash Commands 管理会话
- 通过 Heartbeat 维持上下文连续性
- 通过 sessions_spawn / sessions_yield 进行多 Agent 协作

Isotopes 已具备 Agent loop、workspace、skills、session persistence、Discord transport 和 subagent spawn 等基础能力，但尚未覆盖 Major 与 Tachikoma 的完整协作模式。

本 PRD 用于明确迁移目标、现状差距、范围边界、需求优先级和验收标准。

### 1.2 目标

将 Major 与 Tachikoma 从 OpenClaw 迁移到 Isotopes，并恢复以下能力：

- 在 Discord 中以两个独立 Bot 身份共存
- 各自使用独立 Workspace、Memory、Skills
- 支持基础会话控制与模型切换
- 支持周期性 Heartbeat 与静默机制
- 支持多 Agent 之间的任务派发、协作和结果回传

### 1.3 非目标

本阶段不要求：

- 一次性复刻 OpenClaw 的全部 20+ Slash Commands
- 一次性实现所有治理、安全与清理类增强能力
- 完整替换现有 acpx 机制的所有实现细节

---

## 2. 当前现状

### 2.1 Isotopes 已有能力

当前 Isotopes 已具备以下基础设施：

- Agent loop + compaction + workspace + skills + session persistence
- Discord transport，可用且支持 streaming、debounce、thread binding
- `agents[]` 多 agent 配置骨架
- per-agent workspace 基础实现，`workspaceKey = isSingleAgent ? "default" : agentConfig.id`
- subagent spawn（acpx backend）可运行

### 2.2 与 OpenClaw 的核心差距

| 能力 | OpenClaw | Isotopes 现状 |
| --- | --- | --- |
| 多 Discord Bot | 每个 agent 一个独立 Discord account + token | 单 token，所有 agent 共用一个 bot |
| Slash Commands | 已有 20+ 命令（如 `/new` `/model` `/status`） | 无 |
| Heartbeat | 支持定时 poll + HEARTBEAT.md + proactive 行为 | 无 |
| NO_REPLY / HEARTBEAT_OK | 支持静默机制 | 无 |
| Session Visibility | 支持查看其他 agent 的 session 与历史 | 无 |
| Agent 间通信 | 支持 `sessions_send` | 无 |
| Native `sessions_spawn` | 支持隔离 subagent session 并回推结果 | 仅有 acpx 外部进程 |
| `sessions_yield` | 支持等待子任务完成 | 无 |
| Subagent steer/send | 支持运行时实时干预 | 仅有 `cancelSubagent` |
| Per-agent tool policy | 支持 allow / deny list | 全局统一 |
| Per-agent model | 每个 agent 可使用不同 model | 全局 provider 共享 |

---

## 3. 用户与使用场景

### 3.1 核心角色

- **Steins**：通过 Discord 与 Agent 交互、分配任务、管理 session
- **Major**：承担 Tech Lead 角色，做拆解、调度、Review
- **Tachikoma**：承担执行角色，完成编码与实现

### 3.2 核心使用场景

#### 场景 A：多 Bot 共存

在同一个 Discord Channel 中，Major 与 Tachikoma 以两个不同 Bot 身份出现。用户 `@Major` 与 `@Tachikoma` 时，消息分别路由到对应 Agent。

#### 场景 B：独立 Workspace

Major 与 Tachikoma 各自拥有独立 Workspace，隔离各自的：

- `SOUL.md`
- `IDENTITY.md`
- `MEMORY.md`
- `skills/`
- 会话上下文

#### 场景 C：会话控制

用户通过 Discord Slash Commands 完成：

- 新建或重置 session
- 查看当前状态
- 查看或切换模型

#### 场景 D：周期性自检

系统定期触发 Heartbeat，让 Agent 自主检查项目状态、整理 memory，并决定是否需要回复。

#### 场景 E：多 Agent 协作

Major 可以派生 Tachikoma 或其他子 Agent 执行任务，并等待结果回传；必要时可中途发送补充指令或调整方向。

---

## 4. 问题定义

如果不补齐多 Bot、独立 Workspace、Per-agent 配置、基础会话命令和协作工具链，Major 与 Tachikoma 无法在 Isotopes 中按原有工作方式运行，迁移将不可行。

当前最大的阻塞项包括：

1. 没有多 Discord Bot 支持
2. 没有可配置的 per-agent workspace 路径
3. 没有 per-agent provider / model 配置层
4. 没有基础 Slash Commands
5. 没有 Heartbeat 与静默机制
6. 没有原生多 Agent 协作能力

---

## 5. 需求对比

### 5.1 OpenClaw 当前工作配置

```yaml
agents.list:
  - id: major
    workspace: workspace-major
    agentDir: agents/major/agent
  - id: tachikoma
    workspace: workspace-tachikoma
    agentDir: agents/tachikoma/agent

channels.discord.accounts:
  major:
    token: "..."
  tachikoma:
    token: "..."

bindings:
  - agentId: major
    match:
      channel: discord
      accountId: major
  - agentId: tachikoma
    match:
      channel: discord
      accountId: tachikoma

agents.defaults:
  model.primary: copilot-proxy/claude-opus-4.6
  subagents.model: copilot-proxy/claude-opus-4.6
  sandbox.mode: non-main
```

### 5.2 Isotopes 当前配置状态

```yaml
agents:
  - id: main

discord:
  token: "..."
  defaultAgentId: main
```

当前缺失的 schema 能力：

- `discord.accounts`
- `bindings[].match.accountId`
- `AgentConfigFile.workspace`
- `AgentConfigFile.provider`
- `AgentConfigFile.model`
- `agents.defaults`

---

## 6. 产品范围

### 6.1 In Scope

本次迁移需要支持：

- 多 Discord Bot 账号接入
- 按 Bot / Binding 路由到指定 Agent
- per-agent workspace 路径配置
- per-agent provider / model 覆盖能力
- `agents.defaults` 默认配置层
- 基础 Slash Commands：`/new`、`/status`、`/model`
- Heartbeat 机制
- `NO_REPLY` / `HEARTBEAT_OK` 静默机制
- `sessions_list` / `sessions_history`
- `sessions_send`
- `sessions_spawn` / `sessions_yield`
- subagent steer / send / log 基础能力

### 6.2 Out of Scope

本阶段不包含：

- 完整复刻 OpenClaw 全部 Slash Commands
- 完整权限治理与安全隔离体系
- 所有 Session 生命周期治理能力
- 所有后续增强型 CLI 外部触发能力

---

## 7. 功能需求

### 7.1 P0：不做就无法迁移

#### 7.1.1 Multi-bot Discord 支持

**目标**：每个 Agent 可绑定独立 Discord Bot 身份。

**需求说明：**

- 配置支持 `discord.accounts`，每个 account 对应一个 token
- Transport 层为每个 account 创建独立 Client 实例
- 增加 Binding 路由能力，支持 `match.accountId -> agentId`
- 同一 Channel 中不同 Bot 可独立接收与发送消息

**验收标准：**

- Major 与 Tachikoma 可以作为两个不同 Bot 出现在同一 Discord Channel
- 用户 `@Major` 只触发 Major，`@Tachikoma` 只触发 Tachikoma
- 不同 Bot 的名字、头像、身份独立可见

#### 7.1.2 Per-agent Workspace 路径配置

**目标**：每个 Agent 可绑定独立 Workspace 路径。

**需求说明：**

- `AgentConfigFile.workspace` 支持显式配置
- 支持绝对路径和相对路径
- 未配置时保留默认派生逻辑

**验收标准：**

- Major 和 Tachikoma 可分别指向不同 workspace 目录
- 各自的 memory / identity / skills 文件互不干扰

#### 7.1.3 Per-agent Provider / Model 配置

**目标**：不同 Agent 可使用不同 provider 或 model。

**需求说明：**

- `AgentConfigFile.provider` / `model` 支持 override
- 增加 `agents.defaults` 配置层作为默认值来源
- Agent 级配置优先级高于 defaults

**验收标准：**

- 不同 Agent 可以使用不同模型配置
- 未单独配置时能够正确继承 `agents.defaults`

### 7.2 P1：不做会严重影响使用体验

#### 7.2.1 基础 Slash Commands

**目标**：恢复最基本的会话管理能力。

**首批命令：**

- `/new`：重置或新建当前 session
- `/status`：查看当前 Agent / Session 状态
- `/model`：查看或切换模型

**需求说明：**

- 在 Discord transport 中增加命令解析能力
- 命令与普通消息处理流程隔离
- 命令结果可直接返回到 Discord

**验收标准：**

- 用户无需手动通过 API 删除 session
- 基础命令在 Discord 中可正常使用

#### 7.2.2 Heartbeat 机制

**目标**：让 Agent 能周期性自检与维护上下文连续性。

**需求说明：**

- 增加定时触发器
- 周期性向 Agent session 注入 heartbeat prompt
- 支持读取 `HEARTBEAT.md`
- Agent 可基于 Heartbeat 做检查、整理 memory 或输出状态

**验收标准：**

- Heartbeat 可按配置周期执行
- Agent 能依据 Heartbeat 流程运行
- 不需要回复时可进入静默路径

#### 7.2.3 NO_REPLY / HEARTBEAT_OK 静默机制

**目标**：避免不必要的消息噪音。

**需求说明：**

- Transport 层识别特殊回复内容
- 若返回 `NO_REPLY` 或 `HEARTBEAT_OK`，则不向 Discord 发送消息
- 内部日志仍保留执行记录

**验收标准：**

- Heartbeat 或普通流程中，Agent 可显式选择不回复
- Discord 中不会出现多余提示消息

### 7.3 P2：恢复多 Agent 协作能力

#### 7.3.1 `sessions_list` / `sessions_history`

**目标**：让 Agent 感知其他 session 的存在与上下文。

**需求说明：**

- 提供工具接口列出可见 session
- 支持查看 session 历史摘要或必要内容
- 权限与可见范围初期可采用基础实现

**验收标准：**

- Agent 能识别其他 session
- Agent 能读取指定 session 的基本历史信息

#### 7.3.2 `sessions_send`

**目标**：允许 Agent 向另一个 Agent 的 session 发送消息。

**需求说明：**

- 指定目标 session 或 agent
- 将消息注入目标 session 队列
- 保留发送来源信息

**验收标准：**

- Major 能向 Tachikoma 的 session 发送任务
- 目标 Agent 能收到并处理消息

#### 7.3.3 `sessions_spawn` + `sessions_yield`（Native）

**目标**：支持原生隔离子任务执行与结果回传。

**需求说明：**

- 原生创建隔离 subagent session
- 支持父 session 发起 spawn
- 子任务完成后自动推送结果
- 父 session 可 yield 等待结果
- 支持必要的 cleanup

**验收标准：**

- Major 可创建一个独立 subagent 执行任务
- 父会话无需轮询即可获得结果
- 子任务完成后资源可正确清理

#### 7.3.4 Subagent Steer / Send / Log

**目标**：在 subagent 执行过程中支持实时干预。

**需求说明：**

- 支持给正在运行的 subagent 发送额外指令
- 支持查看运行日志
- 至少具备 steer / send / log 三类基础操作

**验收标准：**

- 用户或父 Agent 可中途调整 subagent 方向
- 可以查看 subagent 当前执行状态或日志

### 7.4 P3：增强项

- per-agent tool allow / deny
- session idle / max-age 自动清理
- agent send CLI 外部触发能力
- 更多 Slash Commands：`/focus`、`/unfocus`、`/agents`、`/subagents`

---

## 8. 配置设计要求

### 8.1 目标配置形态（示意）

```yaml
agents:
  defaults:
    model:
      primary: copilot-proxy/claude-opus-4.6
    subagents:
      model: copilot-proxy/claude-opus-4.6
    sandbox:
      mode: non-main

  list:
    - id: major
      workspace: workspace-major
      provider: copilot-proxy
      model: claude-opus-4.6

    - id: tachikoma
      workspace: workspace-tachikoma
      provider: copilot-proxy
      model: claude-opus-4.6

discord:
  accounts:
    major:
      token: "..."
    tachikoma:
      token: "..."

bindings:
  - agentId: major
    match:
      channel: discord
      accountId: major

  - agentId: tachikoma
    match:
      channel: discord
      accountId: tachikoma
```

### 8.2 Schema 演进要求

必须补齐以下配置结构：

- `discord.accounts`
- `bindings[].match.accountId`
- `AgentConfigFile.workspace`
- `AgentConfigFile.provider`
- `AgentConfigFile.model`
- `agents.defaults`

同时需要保证：

- 老配置可平滑兼容
- 单 Bot / 单 Agent 现有用法不被破坏

---

## 9. 用户故事

### 9.1 作为 Steins

我希望在同一个 Discord Channel 中同时使用 Major 和 Tachikoma，这样我可以直接通过 `@` 不同 Bot 来分配不同任务。

### 9.2 作为 Major

我希望拥有独立 Workspace 和独立 Memory，这样我可以持续维护架构决策和工程管理上下文，而不与 Tachikoma 混淆。

### 9.3 作为 Tachikoma

我希望拥有独立 Workspace、Skills 和 Session，这样我可以专注执行任务并维护实现细节上下文。

### 9.4 作为 Major

我希望通过 `sessions_spawn` 和 `sessions_yield` 派生子任务并等待结果，这样我可以像现在一样做 Tech Lead 式调度和 Review。

### 9.5 作为 Steins

我希望通过 `/new`、`/status`、`/model` 直接在 Discord 中管理会话，而不是手动去 API 层操作。

---

## 10. 成功标准

### 10.1 技术成功标准

- Major 与 Tachikoma 能以两个独立 Discord Bot 身份运行
- 两者拥有独立 Workspace、Memory、Skills
- 两者可配置不同 provider / model
- 用户可通过 `/new`、`/status`、`/model` 管理会话
- Heartbeat 可按周期运行，并支持静默机制
- Agent 之间可查看、发送、派生和等待任务结果

### 10.2 使用成功标准

- Major + Tachikoma 的日常工作流可以从 OpenClaw 平移到 Isotopes
- Steins 无需依赖底层 API 手工清理 session
- Major 与 Tachikoma 在同一 Channel 中协作体验接近现有模式

---

## 11. 风险与注意事项

### 11.1 架构复杂度上升

多 Bot、多 Binding、多 Session 协作会显著提升 Discord transport 与 session store 的复杂度。

### 11.2 Native Spawn 改造成本高

`sessions_spawn + sessions_yield` 涉及 session 隔离、完成通知、结果路由与资源清理，是实现复杂度最高的部分。

### 11.3 配置兼容性风险

从单 Bot / 单 Agent 配置升级到多层 defaults + accounts + bindings，需要处理兼容旧配置、迁移默认值与错误提示的一致性。

---

## 12. 优先级结论

### 第一优先级：确保可运行

1. Multi-bot Discord
2. Per-agent workspace
3. Per-agent provider / model
4. `agents.defaults`

### 第二优先级：确保可用

1. `/new`、`/status`、`/model`
2. Heartbeat
3. `NO_REPLY` / `HEARTBEAT_OK`

### 第三优先级：恢复协作

1. `sessions_list` / `sessions_history`
2. `sessions_send`
3. `sessions_spawn` / `sessions_yield`
4. subagent steer / send / log

---

## 13. 总结

将 Major 与 Tachikoma 迁移到 Isotopes 的首要阻塞项是 **Multi-bot Discord 支持**。只要先补齐：

- Multi-bot Discord
- Per-agent workspace
- Per-agent model / provider

系统即可进入“**基本可运行**”状态。

再补齐：

- 基础 Slash Commands
- Heartbeat
- 静默机制

即可达到“**可日常使用**”状态。

最后补齐：

- `sessions_send`
- `sessions_spawn`
- `sessions_yield`

才能真正恢复 Major 与 Tachikoma 的“**协作生产力**”。
