// src/agent/runners/pi/model-resolution.ts — Resolve a pi-ai Model<Api> from
// global provider config + an explicit model id.

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { ProviderConfig } from "../../types.js";

const DEFAULT_MODEL = "claude-opus-4.7";

export function resolveModel(globalProvider: ProviderConfig, modelId?: string): Model<Api> {
  const provider = globalProvider.type as Parameters<typeof getModel>[0];
  const id = modelId ?? globalProvider.defaultModel ?? DEFAULT_MODEL;
  const model = getModel(provider, id as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
  if (!model) throw new Error(`Unknown ${provider} model: ${id}`);

  const proxyHeaders: Record<string, string> = { ...(globalProvider.headers ?? {}) };
  if (globalProvider.baseUrl && globalProvider.apiKey) {
    proxyHeaders.Authorization ??= `Bearer ${globalProvider.apiKey}`;
  }
  const hasProxyHeaders = Object.keys(proxyHeaders).length > 0;

  if (!globalProvider.baseUrl && !hasProxyHeaders) return model;

  return {
    ...model,
    id,
    ...(globalProvider.baseUrl ? { baseUrl: globalProvider.baseUrl } : {}),
    ...(hasProxyHeaders ? { headers: { ...(model.headers ?? {}), ...proxyHeaders } } : {}),
  };
}
