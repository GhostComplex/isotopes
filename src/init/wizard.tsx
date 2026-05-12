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

const DEFAULT_GHC_MODEL = "claude-opus-4.7";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.7";

type LlmChoice = "ghc-proxy" | "minimax-cn" | "skip";

type Step =
  | { kind: "llm" }
  | { kind: "provider-baseUrl" }
  | { kind: "provider-apiKey" }
  | { kind: "provider-model" }
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
type ConfiguredProvider = Exclude<Provider, { type: "skip" }>;
const isConfigured = (p: Provider): p is ConfiguredProvider => p.type !== "skip";

function InitWizard({ onDone }: Props) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>({ kind: "llm" });

  const [provider, setProvider] = useState<Provider>({ type: "skip" });
  const providerBaseUrl = provider.type === "ghc-proxy" ? provider.baseUrl : "";
  const providerApiKey = isConfigured(provider) ? provider.apiKey : "";
  const providerModel = isConfigured(provider) ? provider.model : "";
  const providerLabel =
    provider.type === "ghc-proxy" ? "ghc-proxy" :
    provider.type === "minimax-cn" ? "MiniMax" : "";
  const setBaseUrl = (v: string) =>
    setProvider((p) => (p.type === "ghc-proxy" ? { ...p, baseUrl: v } : p));
  const setApiKey = (v: string) =>
    setProvider((p) => (isConfigured(p) ? { ...p, apiKey: v } : p));
  const setModel = (v: string) =>
    setProvider((p) => (isConfigured(p) ? { ...p, model: v } : p));

  const [channel, setChannel] = useState<Channel>({ type: "skip" });
  const discordToken = channel.type === "discord" ? channel.token : "";
  const discordDmUserId = channel.type === "discord" ? (channel.dmUserId ?? "") : "";
  const setDiscordField = (patch: Partial<DiscordChannel>) =>
    setChannel((c) => (c.type === "discord" ? { ...c, ...patch } : c));

  // Comma-separated raw input; parsed into Channel.groupAllowlist on submit.
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

  const handleLlmSelect = (item: { value: LlmChoice }) => {
    if (item.value === "ghc-proxy") {
      setProvider({ type: "ghc-proxy", baseUrl: "", apiKey: "", model: DEFAULT_GHC_MODEL });
      setStep({ kind: "provider-baseUrl" });
    } else if (item.value === "minimax-cn") {
      setProvider({ type: "minimax-cn", apiKey: "", model: DEFAULT_MINIMAX_MODEL });
      setStep({ kind: "provider-apiKey" });
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
              { label: "minimax-cn (MiniMax — China endpoint)", value: "minimax-cn" as const },
              { label: "skip (configure later)", value: "skip" as const },
            ]}
            onSelect={handleLlmSelect}
          />
        </Box>
      )}

      {step.kind === "provider-baseUrl" && (
        <Box flexDirection="column">
          <Text>{providerLabel} baseUrl:</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={providerBaseUrl}
              onChange={setBaseUrl}
              onSubmit={() => {
                if (providerBaseUrl.trim().length > 0) setStep({ kind: "provider-apiKey" });
              }}
            />
          </Box>
          {providerBaseUrl.trim().length === 0 && (
            <Text color="yellow">  baseUrl is required</Text>
          )}
        </Box>
      )}

      {step.kind === "provider-apiKey" && (
        <Box flexDirection="column">
          <Text>{providerLabel} apiKey (literal value, stored in yaml):</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={providerApiKey}
              mask="•"
              onChange={setApiKey}
              onSubmit={() => {
                if (providerApiKey.trim().length > 0) setStep({ kind: "provider-model" });
              }}
            />
          </Box>
          {providerApiKey.trim().length === 0 && (
            <Text color="yellow">  apiKey is required</Text>
          )}
        </Box>
      )}

      {step.kind === "provider-model" && (
        <Box flexDirection="column">
          <Text>{providerLabel} model:</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={providerModel}
              onChange={setModel}
              onSubmit={() => {
                if (providerModel.trim().length > 0) goToChannel();
              }}
            />
          </Box>
          {providerModel.trim().length === 0 && (
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
        process.exit(130);
      }
      resolve(collected);
    });
  });
}
