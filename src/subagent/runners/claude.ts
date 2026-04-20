// src/subagent/runners/claude.ts — Runner for the Claude Agent SDK backend
// Extracted from the previous monolithic SubagentBackend.spawn so the
// dispatcher can route agents by type.

import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../core/logger.js";
import {
  DEFAULT_SUBAGENT_ALLOWED_TOOLS,
  type SubagentClaudeConfigFile,
  type SubagentPermissionMode,
} from "../../core/config.js";
import type { SubagentAgent, SubagentEvent, SubagentSpawnOptions } from "../types.js";
import type { RunnerSignals, SubagentRunner } from "../runner.js";

const log = createLogger("subagent:runner:claude");

/** Configuration for {@link ClaudeRunner}. */
export interface ClaudeRunnerOptions {
  /** Default permission mode if a spawn doesn't override. */
  permissionMode?: SubagentPermissionMode;
  /** Default allowlist used when permissionMode is "allowlist". */
  allowedTools?: string[];
  /** Claude-specific settings (auth, base URL, executable path). */
  claude?: SubagentClaudeConfigFile;
}

// ---------------------------------------------------------------------------
// SDK message → SubagentEvent mapping
// ---------------------------------------------------------------------------

/**
 * Map a single SDK message into zero or more SubagentEvents.
 *
 * Pass a persistent `toolNameById` map across calls to resolve `tool_result`
 * blocks back to the real tool name (Read/Edit/...): tool_use blocks carry
 * both id and name; tool_result blocks only carry the id.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  toolNameById?: Map<string, string>,
): SubagentEvent[] {
  const events: SubagentEvent[] = [];

  switch (msg.type) {
    case "assistant": {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            events.push({ type: "message", content: block.text });
          } else if (block.type === "tool_use") {
            const name = String(block.name ?? "");
            if (toolNameById && typeof block.id === "string") toolNameById.set(block.id, name);
            events.push({
              type: "tool_use",
              toolName: name,
              toolInput: block.input,
            });
          }
        }
      }
      return events;
    }

    case "user": {
      if ("isReplay" in msg && msg.isReplay) return events;
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "tool_result"
          ) {
            const b = block as { tool_use_id?: string; content?: unknown };
            const id = String(b.tool_use_id ?? "");
            events.push({
              type: "tool_result",
              toolName: toolNameById?.get(id) ?? id,
              toolResult: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
            });
          }
        }
      }
      return events;
    }

    case "result": {
      if (msg.subtype === "success") {
        events.push({ type: "done", exitCode: 0, costUsd: msg.total_cost_usd });
      } else {
        const errMsg = msg.errors?.join("; ") ?? msg.subtype;
        events.push({ type: "error", error: errMsg });
        events.push({ type: "done", exitCode: 1, costUsd: msg.total_cost_usd });
      }
      return events;
    }

    default:
      return events;
  }
}

// ---------------------------------------------------------------------------
// Permission mode translation
// ---------------------------------------------------------------------------

function translatePermissionMode(
  mode: SubagentPermissionMode,
  allowedTools: string[],
): { permissionMode: PermissionMode; allowedTools?: string[] } {
  switch (mode) {
    case "skip":
      return { permissionMode: "bypassPermissions" };
    case "allowlist":
      return { permissionMode: "default", allowedTools };
    case "default":
      return { permissionMode: "default" };
  }
}

// ---------------------------------------------------------------------------
// ClaudeRunner
// ---------------------------------------------------------------------------

/** Runner backed by `@anthropic-ai/claude-agent-sdk`. */
export class ClaudeRunner implements SubagentRunner {
  readonly agent: SubagentAgent = "claude";

  private permissionMode: SubagentPermissionMode;
  private allowedTools: string[];
  private claude?: SubagentClaudeConfigFile;

  constructor(options?: ClaudeRunnerOptions) {
    this.permissionMode = options?.permissionMode ?? "allowlist";
    this.allowedTools = options?.allowedTools ?? [...DEFAULT_SUBAGENT_ALLOWED_TOOLS];
    this.claude = options?.claude;
  }

  /** Build the SDK Options object for one spawn. */
  buildSdkOptions(options: SubagentSpawnOptions, abort: AbortController): Options {
    const permissionMode = options.permissionMode ?? this.permissionMode;
    const allowedTools = options.allowedTools ?? this.allowedTools;
    const translated = translatePermissionMode(permissionMode, allowedTools);

    const sdkOptions: Options = {
      cwd: options.cwd,
      abortController: abort,
      permissionMode: translated.permissionMode,
    };
    if (translated.allowedTools) sdkOptions.allowedTools = translated.allowedTools;
    if (options.model) sdkOptions.model = options.model;
    if (options.maxTurns !== undefined) sdkOptions.maxTurns = options.maxTurns;
    if (this.claude?.pathToClaudeCodeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = this.claude.pathToClaudeCodeExecutable;
    }

    const envOverrides: Record<string, string> = {};
    if (this.claude?.authToken) envOverrides.ANTHROPIC_AUTH_TOKEN = this.claude.authToken;
    if (this.claude?.baseUrl) envOverrides.ANTHROPIC_BASE_URL = this.claude.baseUrl;
    if (Object.keys(envOverrides).length > 0) {
      sdkOptions.env = { ...process.env, ...envOverrides };
    }

    return sdkOptions;
  }

  async *run(
    taskId: string,
    options: SubagentSpawnOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<SubagentEvent> {
    log.info("ClaudeRunner.run", { taskId, cwd: options.cwd });

    // Bridge external AbortSignal into the SDK's AbortController.
    const sdkAbort = new AbortController();
    const onAbort = () => sdkAbort.abort();
    signals.abort.addEventListener("abort", onAbort, { once: true });
    if (signals.abort.aborted) sdkAbort.abort();

    const toolNameById = new Map<string, string>();
    let sawDone = false;

    try {
      const iterator = query({
        prompt: options.prompt,
        options: this.buildSdkOptions(options, sdkAbort),
      });

      for await (const msg of iterator) {
        for (const ev of mapSdkMessage(msg, toolNameById)) {
          if (ev.type === "done") sawDone = true;
          yield ev;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: msg };
      if (!sawDone) {
        yield { type: "done", exitCode: 1 };
      }
    } finally {
      signals.abort.removeEventListener("abort", onAbort);
    }
  }
}
