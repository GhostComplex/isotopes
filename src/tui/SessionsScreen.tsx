import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getSessions, isDaemonRunning } from "./api.js";
import type { Screen, SessionItem } from "./types.js";

interface Props {
  currentAgentId: string;
  currentSessionKey: string;
  onSwitchScreen: (screen: Screen) => void;
  onSelect: (agentId: string, sessionKey: string) => void;
}

export function SessionsScreen({ currentAgentId, currentSessionKey, onSwitchScreen, onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [running, setRunning] = useState<boolean | null>(null);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const isUp = await isDaemonRunning();
      if (cancelled) return;
      setRunning(isUp);
      if (!isUp) return;
      try {
        const list = await getSessions();
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
        setSessions(sorted);
        setCursor((c) => (sorted.length === 0 ? 0 : Math.min(c, sorted.length - 1)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useInput((_ch, key) => {
    if (key.escape) {
      onSwitchScreen("chat");
      return;
    }
    if (sessions.length === 0) return;
    if (key.upArrow) {
      setCursor((c) => (c - 1 + sessions.length) % sessions.length);
    } else if (key.downArrow) {
      setCursor((c) => (c + 1) % sessions.length);
    } else if (key.return) {
      const chosen = sessions[cursor];
      if (chosen.agentId === currentAgentId && chosen.key === currentSessionKey) {
        onSwitchScreen("chat");
      } else {
        onSelect(chosen.agentId, chosen.key);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>isotopes — sessions</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {running === null && <Text color="gray">Loading…</Text>}
        {running === false && (
          <>
            <Text bold color="red">Daemon not running</Text>
            <Text color="gray">Start with: isotopes start</Text>
          </>
        )}
        {error && <Text color="red">{error}</Text>}
        {running && !error && sessions.length === 0 && (
          <Text color="gray">No active sessions</Text>
        )}
        {sessions.map((s, i) => {
          const selected = i === cursor;
          const isCurrent = s.agentId === currentAgentId && s.key === currentSessionKey;
          const time = s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : "";
          return (
            <Text key={s.key}>
              <Text color={selected ? "cyan" : undefined}>{selected ? "▸ " : "  "}</Text>
              <Text color={selected ? "cyan" : undefined} bold={selected}>{s.agentId}</Text>
              <Text color="gray"> {s.key} {time}</Text>
              {isCurrent && <Text color="green"> (current)</Text>}
            </Text>
          );
        })}
      </Box>

      <Box borderStyle="single" paddingX={1} marginTop={1}>
        <Text dimColor>↑↓ navigate  enter switch  esc back</Text>
      </Box>
    </Box>
  );
}
