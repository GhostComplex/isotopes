import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";

import type {
  Channel,
  CodingAgent,
  InitAnswers,
  Provider,
} from "./types.js";
import { isValidDiscordUserId, parseGroupAllowlist } from "./validators.js";
import { SelectStep, TextStep } from "./steps.js";

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

  const finish = (codingAgent: CodingAgent) => {
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
        <SelectStep
          label="1) LLM provider:"
          items={[
            { label: "ghc-proxy (Anthropic via GHC Coder proxy)", value: "ghc-proxy" },
            { label: "minimax-cn (MiniMax — China endpoint)", value: "minimax-cn" },
            { label: "skip (configure later)", value: "skip" },
          ]}
          onSelect={handleLlmSelect}
        />
      )}

      {step.kind === "provider-baseUrl" && (
        <TextStep
          label={`${providerLabel} baseUrl:`}
          value={providerBaseUrl}
          onChange={setBaseUrl}
          onSubmit={() => {
            if (providerBaseUrl.trim().length > 0) setStep({ kind: "provider-apiKey" });
          }}
          error={providerBaseUrl.trim().length === 0 ? "baseUrl is required" : undefined}
        />
      )}

      {step.kind === "provider-apiKey" && (
        <TextStep
          label={`${providerLabel} apiKey (literal value, stored in yaml):`}
          value={providerApiKey}
          mask
          onChange={setApiKey}
          onSubmit={() => {
            if (providerApiKey.trim().length > 0) setStep({ kind: "provider-model" });
          }}
          error={providerApiKey.trim().length === 0 ? "apiKey is required" : undefined}
        />
      )}

      {step.kind === "provider-model" && (
        <TextStep
          label={`${providerLabel} model:`}
          value={providerModel}
          onChange={setModel}
          onSubmit={() => {
            if (providerModel.trim().length > 0) goToChannel();
          }}
          error={providerModel.trim().length === 0 ? "model is required" : undefined}
        />
      )}

      {step.kind === "channel" && (
        <SelectStep
          label="2) Channel:"
          items={[
            { label: "discord", value: "discord" },
            { label: "skip (configure later)", value: "skip" },
          ]}
          onSelect={handleChannelSelect}
        />
      )}

      {step.kind === "discord-token" && (
        <TextStep
          label="Discord bot token (literal value, stored in yaml):"
          value={discordToken}
          mask
          onChange={(v) => setDiscordField({ token: v })}
          onSubmit={() => {
            if (discordToken.trim().length > 0) setStep({ kind: "discord-dm-policy" });
          }}
          error={discordToken.trim().length === 0 ? "token is required" : undefined}
        />
      )}

      {step.kind === "discord-dm-policy" && (
        <SelectStep
          label="DM (direct message) policy:"
          items={[
            { label: "disabled (default)", value: "disabled" },
            { label: "allowlist (enter your Discord user ID)", value: "allowlist" },
          ]}
          onSelect={(item) => {
            setDiscordField({ dmPolicy: item.value });
            if (item.value === "allowlist") setStep({ kind: "discord-dm-userId" });
            else setStep({ kind: "discord-group-policy" });
          }}
        />
      )}

      {step.kind === "discord-dm-userId" && (
        <TextStep
          label="Your Discord user ID (numeric, e.g. 123456789012345678):"
          value={discordDmUserId}
          onChange={(v) => setDiscordField({ dmUserId: v })}
          onSubmit={() => {
            if (isValidDiscordUserId(discordDmUserId)) setStep({ kind: "discord-group-policy" });
          }}
          error={
            discordDmUserId.trim().length > 0 && !isValidDiscordUserId(discordDmUserId)
              ? "must be a numeric Discord user ID"
              : undefined
          }
        />
      )}

      {step.kind === "discord-group-policy" && (
        <SelectStep
          label="Group (server/guild) policy:"
          items={[
            { label: "allowlist (default — enter server/channel IDs)", value: "allowlist" },
            { label: "open (accept all servers)", value: "open" },
            { label: "disabled (ignore all guild messages)", value: "disabled" },
          ]}
          onSelect={(item) => {
            setDiscordField({ groupPolicy: item.value });
            if (item.value === "allowlist") setStep({ kind: "discord-group-allowlist" });
            else goToClaude();
          }}
        />
      )}

      {step.kind === "discord-group-allowlist" && (
        <Box flexDirection="column">
          <Text>Server/channel allowlist (comma-separated):</Text>
          <Text dimColor>  pick ONE mode — either all serverId, OR all serverId/channelId</Text>
          <Text dimColor>  e.g. 123456789012345678, 234567890123456789</Text>
          <Text dimColor>  or   987654321098765432/111222333444555666, 987654321098765432/777888999000111222</Text>
          <Text dimColor>  leave empty to defer (all guild messages rejected until you edit the yaml)</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={groupAllowlistInput}
              onChange={setGroupAllowlistInput}
              onSubmit={() => {
                const entries = parseGroupAllowlist(groupAllowlistInput);
                if (entries !== null) {
                  if (entries.length > 0) {
                    setDiscordField({ groupAllowlist: entries });
                  }
                  goToClaude();
                }
              }}
            />
          </Box>
          {groupAllowlistInput.trim().length > 0 && parseGroupAllowlist(groupAllowlistInput) === null && (
            <Text color="yellow">  invalid value</Text>
          )}
        </Box>
      )}

      {step.kind === "claude" && (
        <SelectStep
          label="3) Enable A2A coding:"
          items={[
            { label: "claude (default)", value: "claude" },
            { label: "skip", value: "skip" },
          ]}
          onSelect={(item) => {
            finish(item.value);
          }}
        />
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
