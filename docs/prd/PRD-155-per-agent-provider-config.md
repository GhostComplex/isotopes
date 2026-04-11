# PRD-155: Per-agent Provider/Model Config + agents.defaults

## Summary

Allow different agents to use different providers/models, with a defaults layer.

## Current State

```typescript
// AgentConfigFile already has:
export interface AgentConfigFile {
  id: string;
  provider?: ProviderConfigFile;  // ✅ already exists
  // ...
}

// toAgentConfig() merges:
toAgentConfig(agent, config.provider, ...)  // uses global provider as fallback
```

**Gap:** No `agents.defaults` layer — can't set shared defaults that agents inherit unless overriding.

## Target Config Shape

```yaml
agents:
  defaults:
    provider:
      type: anthropic-proxy
      baseUrl: https://proxy.example.com
      model: claude-sonnet-4-20250514
  
  list:
    - id: major
      # inherits from defaults
    
    - id: tachikoma
      provider:
        model: claude-3-5-haiku  # override model only, inherit rest
```

## Changes Required

### 1. Config Schema (`src/core/config.ts`)

```typescript
/** Agent defaults configuration */
export interface AgentDefaultsConfigFile {
  provider?: ProviderConfigFile;
  tools?: AgentToolsConfigFile;
  compaction?: CompactionConfigFile;
  sandbox?: SandboxConfigFile;
}

/** Updated root config */
export interface IsotopesConfigFile {
  provider?: ProviderConfigFile;           // legacy global (kept for compat)
  agents: AgentConfigFile[] | {            // support both array and object form
    defaults?: AgentDefaultsConfigFile;
    list: AgentConfigFile[];
  };
  // ...
}
```

### 2. Config Loading — Normalize in `loadConfig()`

**关键：不要让 union type 扩散**

在 `loadConfig()` 里立即 normalize，下游拿到的还是数组：

```typescript
// In loadConfig(), after YAML parse:
let agentList: AgentConfigFile[];
let agentDefaults: AgentDefaultsConfigFile | undefined;

if (Array.isArray(rawConfig.agents)) {
  // Legacy array form
  agentList = rawConfig.agents;
  agentDefaults = undefined;
} else {
  // New object form
  agentList = rawConfig.agents.list;
  agentDefaults = rawConfig.agents.defaults;
}

// Store normalized result
config.agents = agentList;
config.agentDefaults = agentDefaults;  // new field, parallel to agents
```

这样 `IsotopesConfig`（runtime 类型）的 `agents` 字段保持为 `AgentConfig[]`，不影响现有消费者。

### 3. `toAgentConfig()` Update

```typescript
export function toAgentConfig(
  agent: AgentConfigFile,
  agentDefaults?: AgentDefaultsConfigFile,  // NEW
  globalProvider?: ProviderConfigFile,
  globalTools?: AgentToolsConfigFile,
  globalCompaction?: CompactionConfigFile,
  defaultSandbox?: SandboxConfig,           // EXISTING - also include in merge
): AgentConfig {
  // Merge chain: agent > defaults > global
  const provider = agent.provider ?? agentDefaults?.provider ?? globalProvider;
  const tools = agent.tools ?? agentDefaults?.tools ?? globalTools;
  const compaction = agent.compaction ?? agentDefaults?.compaction ?? globalCompaction;
  const sandbox = agent.sandbox ?? agentDefaults?.sandbox ?? defaultSandbox;
  // ...
}
```

### 4. Update All `toAgentConfig()` Call Sites

Need to grep and update:
- `src/cli.ts` — main entry
- `src/core/agent-manager.ts` — if calling directly
- Any other consumers

### 5. Sandbox Integration

`defaultSandbox` already flows through `toAgentConfig()`. With this change:
- `agent.sandbox` > `agentDefaults.sandbox` > `defaultSandbox` (global)

## Merge Strategy

**Shallow replace, not deep merge:**
- If agent has `provider`, use agent's entire provider block
- If agent has no provider, inherit from defaults
- If defaults has no provider, inherit from global

Why not deep merge: Too complex, hard to predict. If you need to override `model` only, copy the full provider block. Simple and explicit.

## Test Cases

1. Agent with explicit provider uses it
2. Agent without provider inherits from `agents.defaults.provider`
3. Agent without provider + no defaults inherits from `config.provider`
4. Legacy array form `agents: [...]` still works
5. Mixed: some agents override, some inherit
6. **NEW:** defaults has provider, agent has partial provider fields → agent's entire provider block wins (shallow replace, no accidental merge)

## Backward Compatibility

- `agents: [...]` array form continues to work (normalize to list)
- `config.provider` (global) continues to work as lowest-priority fallback
- Existing configs need no changes
- `IsotopesConfig.agents` stays as `AgentConfig[]` at runtime

## Files to Change

1. `src/core/config.ts` — schema + normalize logic + `toAgentConfig()` signature
2. `src/core/config.test.ts` — new tests
3. `src/cli.ts` — pass agentDefaults to toAgentConfig
4. `src/core/agent-manager.ts` — check if calls toAgentConfig directly

## Acceptance Criteria

- [ ] `agents.defaults.provider` config option works
- [ ] Agent-level provider overrides defaults
- [ ] Agents without explicit config inherit from defaults
- [ ] Sandbox also respects defaults chain
- [ ] Backward compatible with existing configs
- [ ] Tests pass
