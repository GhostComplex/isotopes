import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../core/logger.js";
import {
  DEFAULT_SPAWN_ALLOWED_TOOLS,
  type SettingSource,
  type SpawnPermissionMode,
} from "../../core/config.js";
import type { RunnerKind, RunEvent, RunOptions } from "../types.js";
import type { RunnerSignals, Runner } from "../runner.js";

const log = createLogger("agents:runner:external");

export interface ExternalRunnerOptions {
  permissionMode?: SpawnPermissionMode;
  allowedTools?: string[];
  settingSources?: SettingSource[];
}

export function mapSdkToRunEvent(
  msg: SDKMessage,
  toolNameById?: Map<string, string>,
): RunEvent[] {
  const events: RunEvent[] = [];

  switch (msg.type) {
    case "assistant": {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            events.push({ type: "run:message", content: block.text });
          } else if (block.type === "tool_use") {
            const name = String(block.name ?? "");
            if (toolNameById && typeof block.id === "string") toolNameById.set(block.id, name);
            events.push({ type: "run:tool_use", toolName: name, toolInput: block.input });
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
              type: "run:tool_result",
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
        events.push({ type: "run:done", exitCode: 0, costUsd: msg.total_cost_usd });
      } else {
        const errMsg = msg.errors?.join("; ") ?? msg.subtype;
        events.push({ type: "run:error", error: errMsg });
        events.push({ type: "run:done", exitCode: 1, costUsd: msg.total_cost_usd });
      }
      return events;
    }

    default:
      return events;
  }
}

function translatePermissionMode(
  mode: SpawnPermissionMode,
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

export class ExternalRunner implements Runner {
  readonly kind: RunnerKind = "external";

  private permissionMode: SpawnPermissionMode;
  private allowedTools: string[];
  private settingSources: SettingSource[];

  constructor(options?: ExternalRunnerOptions) {
    this.permissionMode = options?.permissionMode ?? "allowlist";
    this.allowedTools = options?.allowedTools ?? [...DEFAULT_SPAWN_ALLOWED_TOOLS];
    this.settingSources = options?.settingSources ?? ["user"];
  }

  buildSdkOptions(options: RunOptions, abort: AbortController): Options {
    const permissionMode = options.permissionMode ?? this.permissionMode;
    const allowedTools = options.allowedTools ?? this.allowedTools;
    const translated = translatePermissionMode(permissionMode, allowedTools);

    const sdkOptions: Options = {
      cwd: options.cwd,
      abortController: abort,
      permissionMode: translated.permissionMode,
      settingSources: this.settingSources,
    };
    if (translated.allowedTools) sdkOptions.allowedTools = translated.allowedTools;
    if (options.model) sdkOptions.model = options.model;
    if (options.maxTurns !== undefined) sdkOptions.maxTurns = options.maxTurns;

    return sdkOptions;
  }

  async *run(
    runId: string,
    options: RunOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<RunEvent> {
    log.info("ExternalRunner.run", { runId, cwd: options.cwd });

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
        for (const ev of mapSdkToRunEvent(msg, toolNameById)) {
          if (ev.type === "run:done") sawDone = true;
          yield ev;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "run:error", error: msg };
      if (!sawDone) {
        yield { type: "run:done", exitCode: 1 };
      }
    } finally {
      signals.abort.removeEventListener("abort", onAbort);
    }
  }
}
