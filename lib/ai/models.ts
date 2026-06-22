// Client-safe AI engine constants & types (no server-only imports).

export type AIEngine = 'anthropic' | 'openai';

export const AI_MODELS: Record<AIEngine, string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
};

/** UI-safe view of AI config: provider/model + whether each key is configured. */
export type AIConfigView = {
  provider: AIEngine;
  model: string | null;
  anthropicKeySet: boolean;
  openaiKeySet: boolean;
  anthropicFromEnv: boolean;
  openaiFromEnv: boolean;
};
