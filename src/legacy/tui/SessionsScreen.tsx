import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { fetchSessions, isDaemonRunning } from "./api.js";
import type { Screen, SessionSummary } from "./types.js";

interface Props {
  onSwitchScreen: (screen: Screen) => void;
  onSelect: (sessionKey: string) => void;
}

export function SessionsScreen({ onSwitchScreen, onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
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
        const list = await fetchSessions();
        if (cancelled) return;
        setSessions(list);
        setCursor((c) => (list.length === 0 ? 0 : Math.min(c, list.length - 1)));
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
      onSelect(sessions[cursor].key);
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
          const time = s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : "";
          return (
            <Text key={s.key}>
              <Text color={selected ? "cyan" : undefined}>{selected ? "▸ " : "  "}</Text>
              <Text color={selected ? "cyan" : undefined} bold={selected}>{s.agentId}</Text>
              <Text color="gray"> {s.key} {time}</Text>
            </Text>
          );
        })}
      </Box>

      <Box borderStyle="single" paddingX={1} marginTop={1}>
        <Text dimColor>↑↓ navigate  enter attach  esc back</Text>
      </Box>
    </Box>
  );
}
