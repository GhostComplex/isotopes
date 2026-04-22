import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AgentMessage } from "../core/types.js";
import type { PiMonoInstance } from "../core/pi-mono.js";
import { loadConfig } from "../core/config.js";
import { PiMonoCore } from "../core/pi-mono.js";
import { DefaultAgentManager } from "../core/agent-manager.js";
import { getConfigPath } from "../core/paths.js";
import { initializeAgent } from "../core/agent-init.js";
import { parseSlashCommand, dispatch, HELP_TEXT } from "./commands.js";
import type { ChatMessage, ToolCallEntry, TuiOptions, Screen } from "./types.js";

const MAX_VISIBLE_MESSAGES = 50;

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
  const agentRef = useRef<PiMonoInstance | null>(null);
  const historyRef = useRef<AgentMessage[]>([]);
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

      agentRef.current = result.instance;
      historyRef.current = [];
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
    if (!agentRef.current || isStreaming) return;
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    historyRef.current.push({ role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage);
    setIsStreaming(true);
    let responseText = "";
    const toolCalls: ToolCallEntry[] = [];
    try {
      for await (const event of agentRef.current.prompt(historyRef.current)) {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          responseText += event.assistantMessageEvent.delta;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: responseText, toolCalls: [...toolCalls] }];
            }
            return [...prev, { role: "assistant", content: responseText, toolCalls: [...toolCalls], timestamp: new Date() }];
          });
        } else if (event.type === "tool_execution_start") {
          toolCalls.push({ id: event.toolCallId, name: event.toolName, args: typeof event.args === "string" ? event.args : JSON.stringify(event.args) });
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, toolCalls: [...toolCalls] }];
            }
            return prev;
          });
        } else if (event.type === "tool_execution_end") {
          const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
          const tc = toolCalls.find((t) => t.id === event.toolCallId);
          if (tc) {
            tc.result = output;
            tc.isError = event.isError;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [...prev, { role: "system", content: `Error: ${msg}`, timestamp: new Date() }]);
    }
    if (responseText) {
      historyRef.current.push({ role: "assistant", content: [{ type: "text", text: responseText }], timestamp: Date.now() } as unknown as AgentMessage);
    }
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
          historyRef.current = [];
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
