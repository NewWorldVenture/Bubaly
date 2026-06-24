// Client-safe AI engine constants & types (no server-only imports).
// OpenAI-only deployment: ChatGPT is the sole engine.

export type AIEngine = 'openai';

export const AI_MODELS: Record<AIEngine, string[]> = {
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
