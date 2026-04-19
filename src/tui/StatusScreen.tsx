import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { fetchStatus, fetchSessions, fetchUsage, isDaemonRunning } from "./api.js";
import type { DaemonStatus, SessionSummary, UsageStats, Screen } from "./types.js";

interface Props {
  onSwitchScreen: (screen: Screen) => void;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${Math.floor(seconds)}s`);
  return parts.join(" ");
}

function formatCost(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function StatusScreen({ onSwitchScreen }: Props) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const refresh = async () => {
    const isUp = await isDaemonRunning();
    setRunning(isUp);
    if (isUp) {
      try {
        const [s, sess, u] = await Promise.all([fetchStatus(), fetchSessions(), fetchUsage()]);
        setStatus(s);
        setSessions(sess);
        setUsage(u);
      } catch {
        // partial failure ok
      }
    }
    setLastRefresh(new Date());
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  useInput((ch, key) => {
    if (ch === "q" || ch === "/") {
      onSwitchScreen("chat");
    }
    if (ch === "r") {
      void refresh();
    }
    if (key.ctrl && ch === "c") {
      process.exit(0);
    }
  });

  if (running === null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">Checking daemon status...</Text>
      </Box>
    );
  }

  if (!running) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">Daemon not running</Text>
        <Text color="gray">Start with: isotopes start</Text>
        <Text />
        <Text dimColor>Press q or / to return to chat</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={process.stdout.rows}>
      <Box borderStyle="single" paddingX={1}>
        <Text bold>isotopes — status</Text>
        <Text color="gray"> (refreshed {lastRefresh.toLocaleTimeString()})</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} gap={1}>
        {status && (
          <Box flexDirection="column">
            <Text bold underline>Daemon</Text>
            <Text>  Version: <Text color="cyan">{status.version}</Text></Text>
            <Text>  Uptime:  <Text color="cyan">{formatUptime(status.uptime)}</Text></Text>
            <Text>  Cron:    <Text color="cyan">{status.cronJobs} job(s)</Text></Text>
          </Box>
        )}

        {usage && (
          <Box flexDirection="column">
            <Text bold underline>Usage</Text>
            <Text>  Tokens: <Text color="cyan">{usage.totalTokens.toLocaleString()}</Text> ({usage.input.toLocaleString()} in / {usage.output.toLocaleString()} out)</Text>
            <Text>  Cost:   <Text color="cyan">{formatCost(usage.cost)}</Text> ({usage.turns} turns)</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold underline>Sessions ({sessions.length})</Text>
          {sessions.length === 0 && <Text color="gray">  No active sessions</Text>}
          {sessions.slice(0, 20).map((s) => (
            <Text key={s.id}>
              {"  "}<Text color="cyan">{s.agentId}</Text>
              <Text color="gray"> [{s.source}] {s.id.slice(0, 8)}… {s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : ""}</Text>
            </Text>
          ))}
          {sessions.length > 20 && <Text color="gray">  ... and {sessions.length - 20} more</Text>}
        </Box>
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text dimColor>q/← return to chat  r refresh  Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}
