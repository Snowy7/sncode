export interface ModelEntry {
  id: string;
  label: string;
  provider: "anthropic" | "codex";
}

export const ALL_MODELS: ModelEntry[] = [
  { id: "claude-opus-4-6",              label: "Opus 4.6",         provider: "anthropic" },
  { id: "claude-sonnet-4-5",            label: "Sonnet 4.5",       provider: "anthropic" },
  { id: "claude-haiku-4-5",             label: "Haiku 4.5",        provider: "anthropic" },
  { id: "gpt-5.3-codex",                label: "Codex 5.3",        provider: "codex" },
  { id: "gpt-5.2-codex",                label: "Codex 5.2",        provider: "codex" },
  { id: "gpt-5.1-codex-mini",           label: "Codex 5.1 Mini",   provider: "codex" },
];

export const DEFAULT_ANTHROPIC_MODEL = ALL_MODELS[0].id;
export const DEFAULT_CODEX_MODEL = ALL_MODELS[3].id;

export function labelForModelId(id: string): string {
  return ALL_MODELS.find((m) => m.id === id)?.label ?? id;
}

export function providerForModelId(id: string): "anthropic" | "codex" | null {
  return ALL_MODELS.find((m) => m.id === id)?.provider ?? null;
}

/**
 * Return the cheapest / smallest model available given authorized providers.
 * Order of preference: haiku → codex-mini → sonnet → codex-5.2 → codex-5.3 → opus
 */
const TITLE_MODEL_PRIORITY: string[] = [
  "claude-haiku-4-5",
  "gpt-5.1-codex-mini",
  "claude-sonnet-4-5",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "claude-opus-4-6",
];

export function smallestAvailableModelId(authorizedProviderIds: Set<string>): string | null {
  for (const modelId of TITLE_MODEL_PRIORITY) {
    const entry = ALL_MODELS.find((m) => m.id === modelId);
    if (entry && authorizedProviderIds.has(entry.provider)) return modelId;
  }
  return null;
}

/** URLs for the API Key auth mode — direct key management consoles */
export const API_KEY_URLS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  codex: "https://platform.openai.com/api-keys",
};


