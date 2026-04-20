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

export interface DiscordAnswers {
  token: string;
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
  | { kind: "discord-token" };

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
      ...(channel === "discord" ? { discord: { token: discordToken } } : {}),
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
                if (discordToken.trim().length > 0) finish();
              }}
            />
          </Box>
          {discordToken.trim().length === 0 && (
            <Text color="yellow">  token is required</Text>
          )}
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
