// src/init/wizard.tsx — Interactive ink wizard for `isotopes init`
// Two prompts (LLM, channel) each followed by a small input form when the
// user picks something other than "skip". Returns the collected answers; the
// caller is responsible for rendering them into the yaml config.

import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmChoice = "ghc-proxy" | "skip";
export type ChannelChoice = "discord" | "skip";

export interface GhcProxyAnswers {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type DmPolicyChoice = "disabled" | "allowlist";
export type GroupPolicyChoice = "disabled" | "allowlist" | "open";

export interface DiscordAnswers {
  token: string;
  dmPolicy: DmPolicyChoice;
  dmUserId?: string;
  groupPolicy: GroupPolicyChoice;
  groupAllowlist?: string[];
}

export interface InitAnswers {
  llm: LlmChoice;
  ghcProxy?: GhcProxyAnswers;
  channel: ChannelChoice;
  discord?: DiscordAnswers;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_GHC_BASE_URL = "https://api.ghccoder.com";
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
  | { kind: "discord-group-allowlist" };

interface Props {
  onDone: (answers: InitAnswers) => void;
}

function InitWizard({ onDone }: Props) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>({ kind: "llm" });

  const [llm, setLlm] = useState<LlmChoice>("skip");
  const [ghcBaseUrl, setGhcBaseUrl] = useState(DEFAULT_GHC_BASE_URL);
  const [ghcApiKey, setGhcApiKey] = useState("");
  const [ghcModel, setGhcModel] = useState(DEFAULT_GHC_MODEL);

  const [channel, setChannel] = useState<ChannelChoice>("skip");
  const [discordToken, setDiscordToken] = useState("");
  const [dmPolicy, setDmPolicy] = useState<DmPolicyChoice>("disabled");
  const [discordDmUserId, setDiscordDmUserId] = useState("");
  const [groupPolicy, setGroupPolicy] = useState<GroupPolicyChoice>("allowlist");
  const [groupAllowlistInput, setGroupAllowlistInput] = useState("");

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
      process.exit(130);
    }
  });

  const finish = (overrides: Partial<InitAnswers> = {}) => {
    const answers: InitAnswers = {
      llm,
      channel,
      ...(llm === "ghc-proxy"
        ? { ghcProxy: { baseUrl: ghcBaseUrl, apiKey: ghcApiKey, model: ghcModel } }
        : {}),
      ...(channel === "discord"
        ? {
            discord: {
              token: discordToken,
              dmPolicy,
              ...(dmPolicy === "allowlist" && discordDmUserId.trim().length > 0
                ? { dmUserId: discordDmUserId.trim() }
                : {}),
              groupPolicy,
              ...(groupPolicy === "allowlist" && groupAllowlistInput.trim().length > 0
                ? { groupAllowlist: groupAllowlistInput.trim().split(",").map((s) => s.trim()) }
                : {}),
            },
          }
        : {}),
      ...overrides,
    };
    onDone(answers);
    exit();
  };

  const goToChannel = () => setStep({ kind: "channel" });

  const handleLlmSelect = (item: { value: LlmChoice }) => {
    setLlm(item.value);
    if (item.value === "ghc-proxy") setStep({ kind: "ghc-baseUrl" });
    else goToChannel();
  };

  const handleChannelSelect = (item: { value: ChannelChoice }) => {
    setChannel(item.value);
    if (item.value === "discord") setStep({ kind: "discord-token" });
    else finish({ channel: item.value });
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
              onChange={setGhcBaseUrl}
              onSubmit={() => setStep({ kind: "ghc-apiKey" })}
            />
          </Box>
        </Box>
      )}

      {step.kind === "ghc-apiKey" && (
        <Box flexDirection="column">
          <Text>ghc-proxy apiKey (literal value, stored in yaml):</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={ghcApiKey}
              onChange={setGhcApiKey}
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
              onChange={setGhcModel}
              onSubmit={goToChannel}
            />
          </Box>
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
              onChange={setDiscordToken}
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
              setDmPolicy(item.value);
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
              onChange={setDiscordDmUserId}
              onSubmit={() => {
                if (/^\d+$/.test(discordDmUserId.trim())) setStep({ kind: "discord-group-policy" });
              }}
            />
          </Box>
          {discordDmUserId.trim().length > 0 && !/^\d+$/.test(discordDmUserId.trim()) && (
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
              setGroupPolicy(item.value);
              if (item.value === "allowlist") setStep({ kind: "discord-group-allowlist" });
              else finish();
            }}
          />
        </Box>
      )}

      {step.kind === "discord-group-allowlist" && (
        <Box flexDirection="column">
          <Text>Server/channel allowlist (format: serverId or serverId/channelId, comma-separated):</Text>
          <Text dimColor>  e.g. 123456789012345678, 987654321098765432/111222333444555666</Text>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={groupAllowlistInput}
              onChange={setGroupAllowlistInput}
              onSubmit={() => {
                const entries = groupAllowlistInput.trim().split(",").map((s) => s.trim()).filter(Boolean);
                const valid = entries.every((e) => /^\d+(\/\d+)?$/.test(e));
                if (entries.length > 0 && valid) finish();
              }}
            />
          </Box>
          {groupAllowlistInput.trim().length > 0 && (() => {
            const entries = groupAllowlistInput.trim().split(",").map((s) => s.trim()).filter(Boolean);
            const valid = entries.every((e) => /^\d+(\/\d+)?$/.test(e));
            return !valid ? <Text color="yellow">  each entry must be serverId or serverId/channelId (numeric)</Text> : null;
          })()}
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
