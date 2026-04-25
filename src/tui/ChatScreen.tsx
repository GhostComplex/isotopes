import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AgentServiceCache } from "../core/pi-mono.js";
import { loadConfig } from "../core/config.js";
import { PiMonoCore } from "../core/pi-mono.js";
import { DefaultAgentManager } from "../core/agent-manager.js";
import { getConfigPath } from "../core/paths.js";
import { initializeAgent } from "../core/agent-init.js";
import { parseSlashCommand, dispatch, HELP_TEXT } from "./commands.js";
import type { ChatMessage, ToolCallEntry, TuiOptions, Screen } from "./types.js";
import { createLogger } from "../core/logger.js";
import { runAgentLoop } from "../core/agent-runner.js";
import { agentEventBus } from "../core/agent-event-bus.js";
import { SessionStoreManager } from "../core/session-store-manager.js";
import type { SessionStore } from "../core/types.js";

const MAX_VISIBLE_MESSAGES = 50;
const log = createLogger("tui");

interface Props {
  options: TuiOptions;
  onSwitchScreen: (screen: Screen) => void;
}

export function ChatScreen({ options, onSwitchScreen }: Props) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [agentId, setAgentId] = useState(options.agent ?? "");
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<AgentServiceCache | null>(null);
  const systemPromptRef = useRef("");
  const storeRef = useRef<{ store: SessionStore; sessionId: string } | null>(null);
  const sessionStoreManagerRef = useRef(new SessionStoreManager());
  const autoMessageSent = useRef(false);

  const initAgent = useCallback(async (requestedAgent?: string) => {
    setAgentReady(false);
    setError(null);
    try {
      const configPath = options.config ?? getConfigPath();
      const config = await loadConfig(configPath);
      if (config.agents.length === 0) {
        setError("No agents configured");
        return;
      }
      const id = requestedAgent ?? config.agents[0]?.id;
      const agentFile = config.agents.find((a) => a.id === id);
      if (!agentFile) {
        setError(`Agent "${id}" not found. Available: ${config.agents.map((a) => a.id).join(", ")}`);
        return;
      }
      setAgentId(agentFile.id);

      const core = new PiMonoCore();
      const mgr = new DefaultAgentManager(core);
      const result = await initializeAgent({
        agentFile,
        agentDefaults: config.agentDefaults,
        provider: config.provider,
        globalTools: config.tools,
        compaction: config.compaction,
        sandbox: config.sandbox,
        subagent: config.subagent,
        core,
        agentManager: mgr,
      });

      cacheRef.current = result.instance;
      systemPromptRef.current = result.systemPrompt;

      const store = await sessionStoreManagerRef.current.getOrCreate(agentFile.id);
      const mainKey = `tui:${agentFile.id}:main`;
      const existing = await store.findByKey(mainKey);
      let sessionId: string;
      if (existing) {
        sessionId = existing.id;
        log.info(`Attached to existing main session: ${sessionId}`);
      } else {
        const session = await store.create(agentFile.id, { key: mainKey, transport: "web" });
        sessionId = session.id;
        log.info(`Created new main session: ${sessionId}`);
      }
      storeRef.current = { store, sessionId };
      setAgentReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [options.config]);

  useEffect(() => {
    void initAgent(options.agent);
  }, []);

  useEffect(() => {
    if (agentReady && options.message && !autoMessageSent.current) {
      autoMessageSent.current = true;
      void sendMessage(options.message);
    }
  }, [agentReady]);

  const sendMessage = async (text: string) => {
    if (!cacheRef.current || !storeRef.current || isStreaming) return;
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    const { store, sessionId } = storeRef.current;
    let responseText = "";
    const toolCalls: ToolCallEntry[] = [];

    const unsub = agentEventBus.session(sessionId).on((e) => {
      if (e.type === "message_update") {
        const ame = e.assistantMessageEvent;
        if (ame.type === "text_delta") {
          responseText += ame.delta;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: responseText, toolCalls: [...toolCalls] }];
            }
            return [...prev, { role: "assistant", content: responseText, toolCalls: [...toolCalls], timestamp: new Date() }];
          });
        }
      } else if (e.type === "tool_execution_start") {
        toolCalls.push({ id: e.toolCallId, name: e.toolName, args: typeof e.args === "string" ? e.args : JSON.stringify(e.args) });
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, toolCalls: [...toolCalls] }];
          }
          return prev;
        });
      } else if (e.type === "tool_execution_end") {
        const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
        const tc = toolCalls.find((t) => t.id === e.toolCallId);
        if (tc) {
          tc.result = output;
          tc.isError = e.isError;
        }
      }
    });

    try {
      await runAgentLoop({
        cache: cacheRef.current,
        sessionStore: store,
        sessionId,
        systemPrompt: systemPromptRef.current,
        textInput: text,
        log,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [...prev, { role: "system", content: `Error: ${msg}`, timestamp: new Date() }]);
    }

    unsub();
    setIsStreaming(false);
  };

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const slash = parseSlashCommand(text);
    if (slash) {
      const handled = dispatch(slash.command, slash.args, {
        onNewChat: () => {
          setMessages([]);
          void (async () => {
            if (!storeRef.current) return;
            const store = storeRef.current.store;
            const newSession = await store.create(agentId, { transport: "web" });
            storeRef.current = { store, sessionId: newSession.id };
            log.info(`New chat session: ${newSession.id}`);
          })();
          setMessages([{ role: "system", content: "New conversation started.", timestamp: new Date() }]);
        },
        onSwitchAgent: (id) => void initAgent(id),
        onExit: () => exit(),
        onShowStatus: () => onSwitchScreen("status"),
        onShowChat: () => {},
        onHelp: () => setMessages((prev) => [...prev, { role: "system", content: HELP_TEXT, timestamp: new Date() }]),
      });
      if (!handled) {
        setMessages((prev) => [...prev, { role: "system", content: `Unknown command: /${slash.command}`, timestamp: new Date() }]);
      }
      return;
    }
    void sendMessage(text);
  };

  useInput((ch, key) => {
    if (isStreaming) return;
    if (key.return) {
      handleSubmit();
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (key.ctrl && ch === "c") {
      exit();
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);

  return (
    <Box flexDirection="column" height={process.stdout.rows}>
      <Box borderStyle="single" paddingX={1}>
        <Text bold>isotopes</Text>
        <Text> — agent: </Text>
        <Text color="cyan">{agentId || "loading..."}</Text>
        {isStreaming && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {error && <Text color="red">{error}</Text>}
        {!agentReady && !error && <Text color="gray">Loading agent...</Text>}
        {visible.map((msg, i) => (
          <Box key={i} flexDirection="column">
            <Text>
              <Text color={msg.role === "user" ? "green" : msg.role === "assistant" ? "blue" : "gray"} bold>
                {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}
              </Text>
              <Text>: {msg.content}</Text>
            </Text>
            {msg.toolCalls?.map((tc) => (
              <Text key={tc.id} color="gray" dimColor>
                {"  "}🔧 {tc.name}{tc.result ? ` → ${tc.result.slice(0, 80)}` : " ..."}
              </Text>
            ))}
          </Box>
        ))}
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text color="green">&gt; </Text>
        <Text>{input}</Text>
        <Text color="gray">█</Text>
      </Box>
    </Box>
  );
}
