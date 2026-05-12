// src/init/wizard.tsx — Interactive ink wizard for `isotopes init`
// Two prompts (LLM, channel) each followed by a small input form when the
// user picks something other than "skip". Returns the collected answers; the
// caller is responsible for rendering them into the yaml config.

import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";

import type {
  Channel,
  CodingAgentChoice,
  InitAnswers,
  Provider,
} from "./types.js";
import { isValidDiscordUserId, parseGroupAllowlist } from "./validators.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_GHC_MODEL = "claude-opus-4.7";

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

type Step =
  | { kind: "llm" }
  | { kind: "ghc-baseUrl" }
  | { kind: "ghc-apiKey" }
  | { kind: "ghc-model" }
  | { kind: "channel" }
  | { kind: "discord-token" }
  | { kind: "discord-dm-policy" }
  | { kind: "discord-dm-userId" }
  | { kind: "discord-group-policy" }
  | { kind: "discord-group-allowlist" }
  | { kind: "claude" };

interface Props {
  onDone: (answers: InitAnswers) => void;
}

type DiscordChannel = Extract<Channel, { type: "discord" }>;

function InitWizard({ onDone }: Props) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>({ kind: "llm" });

  const [provider, setProvider] = useState<Provider>({ type: "skip" });
  const ghcBaseUrl = provider.type === "ghc-proxy" ? provider.baseUrl : "";
  const ghcApiKey = provider.type === "ghc-proxy" ? provider.apiKey : "";
  const ghcModel = provider.type === "ghc-proxy" ? provider.model : DEFAULT_GHC_MODEL;
  const setGhcField = (patch: Partial<Extract<Provider, { type: "ghc-proxy" }>>) =>
    setProvider((p) => (p.type === "ghc-proxy" ? { ...p, ...patch } : p));

  const [channel, setChannel] = useState<Channel>({ type: "skip" });
  const discordToken = channel.type === "discord" ? channel.token : "";
  const discordDmUserId = channel.type === "discord" ? (channel.dmUserId ?? "") : "";
  const setDiscordField = (patch: Partial<DiscordChannel>) =>
    setChannel((c) => (c.type === "discord" ? { ...c, ...patch } : c));

  // groupAllowlist is comma-separated raw input; parsed into Channel.groupAllowlist
  // only when the user successfully submits the step.
  const [groupAllowlistInput, setGroupAllowlistInput] = useState("");

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
      process.exit(130);
    }
  });

  const finish = (codingAgent: CodingAgentChoice) => {
    onDone({ provider, channel, codingAgent });
    exit();
  };

  const goToChannel = () => setStep({ kind: "channel" });
  const goToClaude = () => setStep({ kind: "claude" });

  const handleLlmSelect = (item: { value: "ghc-proxy" | "skip" }) => {
    if (item.value === "ghc-proxy") {
      setProvider({ type: "ghc-proxy", baseUrl: "", apiKey: "", model: DEFAULT_GHC_MODEL });
      setStep({ kind: "ghc-baseUrl" });
    } else {
      setProvider({ type: "skip" });
      goToChannel();
    }
  };

  const handleChannelSelect = (item: { value: "discord" | "skip" }) => {
    if (item.value === "discord") {
      setChannel({
        type: "discord",
        token: "",
        dmPolicy: "disabled",
        groupPolicy: "allowlist",
      });
      setStep({ kind: "discord-token" });
    } else {
      setChannel({ type: "skip" });
      goToClaude();
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Isotopes setup</Text>
      </Box>

      {step.kind === "llm" && (
        <Box flexDirection="column">
          <Text>1) LLM provider:</Text>
          <SelectInput
            items={[
              { label: "ghc-proxy (Anthropic via GHC Coder proxy)", value: "ghc-proxy" as const },
              { label: "skip (configure later)", value: "skip" as const },
            ]}
            onSelect={handleLlmSelect}
          />
        </Box>
      )}

      {step.kind === "ghc-baseUrl" && (
        <Box flexDirection="column">
          <Text>ghc-proxy baseUrl:</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={ghcBaseUrl}
              onChange={(v) => setGhcField({ baseUrl: v })}
              onSubmit={() => {
                if (ghcBaseUrl.trim().length > 0) setStep({ kind: "ghc-apiKey" });
              }}
            />
          </Box>
          {ghcBaseUrl.trim().length === 0 && (
            <Text color="yellow">  baseUrl is required</Text>
          )}
        </Box>
      )}

      {step.kind === "ghc-apiKey" && (
        <Box flexDirection="column">
          <Text>ghc-proxy apiKey (literal value, stored in yaml):</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={ghcApiKey}
              mask="•"
              onChange={(v) => setGhcField({ apiKey: v })}
              onSubmit={() => {
                if (ghcApiKey.trim().length > 0) setStep({ kind: "ghc-model" });
              }}
            />
          </Box>
          {ghcApiKey.trim().length === 0 && (
            <Text color="yellow">  apiKey is required</Text>
          )}
        </Box>
      )}

      {step.kind === "ghc-model" && (
        <Box flexDirection="column">
          <Text>ghc-proxy model:</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={ghcModel}
              onChange={(v) => setGhcField({ model: v })}
              onSubmit={() => {
                if (ghcModel.trim().length > 0) goToChannel();
              }}
            />
          </Box>
          {ghcModel.trim().length === 0 && (
            <Text color="yellow">  model is required</Text>
          )}
        </Box>
      )}

      {step.kind === "channel" && (
        <Box flexDirection="column">
          <Text>2) Channel:</Text>
          <SelectInput
            items={[
              { label: "discord", value: "discord" as const },
              { label: "skip (configure later)", value: "skip" as const },
            ]}
            onSelect={handleChannelSelect}
          />
        </Box>
      )}

      {step.kind === "discord-token" && (
        <Box flexDirection="column">
          <Text>Discord bot token (literal value, stored in yaml):</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={discordToken}
              mask="•"
              onChange={(v) => setDiscordField({ token: v })}
              onSubmit={() => {
                if (discordToken.trim().length > 0) setStep({ kind: "discord-dm-policy" });
              }}
            />
          </Box>
          {discordToken.trim().length === 0 && (
            <Text color="yellow">  token is required</Text>
          )}
        </Box>
      )}

      {step.kind === "discord-dm-policy" && (
        <Box flexDirection="column">
          <Text>DM (direct message) policy:</Text>
          <SelectInput
            items={[
              { label: "disabled (default)", value: "disabled" as const },
              { label: "allowlist (enter your Discord user ID)", value: "allowlist" as const },
            ]}
            onSelect={(item) => {
              setDiscordField({ dmPolicy: item.value });
              if (item.value === "allowlist") setStep({ kind: "discord-dm-userId" });
              else setStep({ kind: "discord-group-policy" });
            }}
          />
        </Box>
      )}

      {step.kind === "discord-dm-userId" && (
        <Box flexDirection="column">
          <Text>Your Discord user ID (numeric, e.g. 123456789012345678):</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={discordDmUserId}
              onChange={(v) => setDiscordField({ dmUserId: v })}
              onSubmit={() => {
                if (isValidDiscordUserId(discordDmUserId)) setStep({ kind: "discord-group-policy" });
              }}
            />
          </Box>
          {discordDmUserId.trim().length > 0 && !isValidDiscordUserId(discordDmUserId) && (
            <Text color="yellow">  must be a numeric Discord user ID</Text>
          )}
        </Box>
      )}

      {step.kind === "discord-group-policy" && (
        <Box flexDirection="column">
          <Text>Group (server/guild) policy:</Text>
          <SelectInput
            items={[
              { label: "allowlist (default — enter server/channel IDs)", value: "allowlist" as const },
              { label: "open (accept all servers)", value: "open" as const },
              { label: "disabled (ignore all guild messages)", value: "disabled" as const },
            ]}
            onSelect={(item) => {
              setDiscordField({ groupPolicy: item.value });
              if (item.value === "allowlist") setStep({ kind: "discord-group-allowlist" });
              else goToClaude();
            }}
          />
        </Box>
      )}

      {step.kind === "discord-group-allowlist" && (
        <Box flexDirection="column">
          <Text>Server/channel allowlist (comma-separated):</Text>
          <Text dimColor>  pick ONE mode — either all serverId, OR all serverId/channelId</Text>
          <Text dimColor>  e.g. 123456789012345678, 234567890123456789</Text>
          <Text dimColor>  or   987654321098765432/111222333444555666, 987654321098765432/777888999000111222</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={groupAllowlistInput}
              onChange={setGroupAllowlistInput}
              onSubmit={() => {
                const result = parseGroupAllowlist(groupAllowlistInput);
                if (result.ok) {
                  setDiscordField({ groupAllowlist: result.entries });
                  goToClaude();
                }
              }}
            />
          </Box>
          {groupAllowlistInput.trim().length > 0 && (() => {
            const result = parseGroupAllowlist(groupAllowlistInput);
            if (result.ok) return null;
            if (result.reason === "format") {
              return <Text color="yellow">  each entry must be serverId or serverId/channelId (numeric)</Text>;
            }
            if (result.reason === "mixed") {
              return <Text color="yellow">  pick one mode: all serverId, OR all serverId/channelId — not mixed</Text>;
            }
            return null;
          })()}
        </Box>
      )}

      {step.kind === "claude" && (
        <Box flexDirection="column">
          <Text>3) Enable A2A coding:</Text>
          <SelectInput
            items={[
              { label: "claude (default)", value: "claude" as const },
              { label: "skip", value: "skip" as const },
            ]}
            onSelect={(item: { value: CodingAgentChoice }) => {
              finish(item.value);
            }}
          />
        </Box>
      )}
    </Box>
  );
}

export async function runInitWizard(): Promise<InitAnswers> {
  const { render } = await import("ink");
  return new Promise((resolve) => {
    let collected: InitAnswers | undefined;
    const { waitUntilExit } = render(
      <InitWizard
        onDone={(a) => {
          collected = a;
        }}
      />,
    );
    void waitUntilExit().then(() => {
      if (!collected) {
        // User Ctrl+C'd before answering — exit non-zero from caller.
        process.exit(130);
      }
      resolve(collected);
    });
  });
}
