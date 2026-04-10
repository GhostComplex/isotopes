# OpenClaw Tool Profile ASCII Notes

This file captures the simplified ASCII diagrams discussed in chat.

## 1. OpenClaw profile flow

```ascii
+---------------------------+
| Global config             |
| tools.profile = coding    |
| tools.allow / tools.deny  |
+-------------+-------------+
              |
              v
+---------------------------+
| Agent config              |
| agents[].tools.profile    |
| agents[].tools.allow/deny |
+-------------+-------------+
              |
              v
+---------------------------+
| Tool policy pipeline      |
|                           |
| 1. profile base allowlist |
| 2. provider overrides     |
| 3. global allow/deny      |
| 4. agent allow/deny       |
| 5. group/channel policy   |
+-------------+-------------+
              |
              v
+---------------------------+
| Final runtime tool set    |
| only filtered tools stay  |
+-------------+-------------+
              |
              v
+---------------------------+
| System prompt: Tooling    |
| model sees only these     |
+-------------+-------------+
              |
              v
+---------------------------+
| Execution-time guards     |
| workspaceOnly             |
| sandbox                   |
| approval / elevated exec  |
+---------------------------+
```

## 2. Skill vs profile

```ascii
+-------------------+      +----------------------+
| Skill             |      | Profile              |
+-------------------+      +----------------------+
| Extra knowledge   |      | Base tool allowlist  |
| Prompt guidance   |      | Tool permission set  |
| Workflow hints    |      | Access policy input  |
+-------------------+      +----------------------+
```

## 3. Why it looks active on every agent

```ascii
        tools.profile (global)
                 |
                 v
      +-----------------------+
      | all agents inherit it |
      +-----------------------+
                 |
                 v
   unless agents[].tools.profile overrides
```

## 4. Short interpretation

```ascii
profile  = 先决定“默认给哪些工具”
allow    = 再做补充开放
deny     = 再做额外收紧
guards   = 最后执行时继续拦
```
