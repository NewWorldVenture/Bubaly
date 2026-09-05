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

// ── Task → model routing constants (P1-05) ───────────────────────────────────
// These live here, next to the admin dropdown, because they are plain data with
// no server imports: `lib/ai/routing.ts` resolves them at request time and the
// admin form renders the same list, so the dropdown can never offer a model the
// router would reject.

/**
 * The kinds of model work the app does. Cheap models handle the high-volume,
 * low-stakes tasks; only planning and reasoning pay for the strong model.
 */
export type AITask = 'classify' | 'extract' | 'plan' | 'reason' | 'summarize' | 'transform' | 'vision';

export const AI_TASKS: readonly AITask[] = ['classify', 'extract', 'plan', 'reason', 'summarize', 'transform', 'vision'];

/**
 * What a model can actually do. `maxTokensParam` matters because the o-series
 * Chat Completions endpoint rejects `max_tokens` outright — sending the wrong
 * parameter name turns a valid model choice into a 400 on every call.
 */
export type ModelCapabilities = {
  /** Supports `response_format: {type:'json_schema', strict:true}`. */
  jsonSchema: boolean;
  /** Supports function/tool calling. */
  tools: boolean;
  /** Accepts image_url content parts. */
  vision: boolean;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
};

/**
 * Capability allow-list, keyed by model-id prefix and matched longest-first.
 * A model that matches nothing here is unknown to us and is never routed to.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'gpt-4o-mini': { jsonSchema: true, tools: true, vision: true, maxTokensParam: 'max_tokens' },
  'gpt-4o': { jsonSchema: true, tools: true, vision: true, maxTokensParam: 'max_tokens' },
  'gpt-4.1': { jsonSchema: true, tools: true, vision: true, maxTokensParam: 'max_tokens' },
  'gpt-4-turbo': { jsonSchema: false, tools: true, vision: true, maxTokensParam: 'max_tokens' },
  'gpt-3.5-turbo': { jsonSchema: false, tools: true, vision: false, maxTokensParam: 'max_tokens' },
  'chatgpt-4o': { jsonSchema: false, tools: false, vision: true, maxTokensParam: 'max_tokens' },
  'o4-mini': { jsonSchema: true, tools: true, vision: true, maxTokensParam: 'max_completion_tokens' },
  'o3-mini': { jsonSchema: true, tools: true, vision: false, maxTokensParam: 'max_completion_tokens' },
  'o3': { jsonSchema: true, tools: true, vision: true, maxTokensParam: 'max_completion_tokens' },
  'o1-mini': { jsonSchema: false, tools: false, vision: false, maxTokensParam: 'max_completion_tokens' },
  'o1': { jsonSchema: true, tools: true, vision: true, maxTokensParam: 'max_completion_tokens' },
};

/** Capabilities for a model id, or null when the id is not on the allow-list. */
export function modelCapabilities(model: string | null | undefined): ModelCapabilities | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  let best: string | null = null;
  for (const prefix of Object.keys(MODEL_CAPABILITIES)) {
    if (id.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best ? MODEL_CAPABILITIES[best] : null;
}

/** Cheap model for the high-volume tasks; the strong model only where it pays. */
export const DEFAULT_TASK_MODELS: Record<AITask, string> = {
  classify: 'gpt-4o-mini',
  extract: 'gpt-4o-mini',
  summarize: 'gpt-4o-mini',
  transform: 'gpt-4o-mini',
  plan: 'gpt-4.1',
  reason: 'gpt-4.1',
  vision: 'gpt-4o',
};

/**
 * What each task needs from a model. Every task needs strict structured output
 * except `summarize` (prose) and `transform`, which are still routed through
 * models that happen to support it; `vision` additionally needs image input.
 */
export const TASK_REQUIREMENTS: Record<AITask, (keyof Omit<ModelCapabilities, 'maxTokensParam'>)[]> = {
  classify: ['jsonSchema'],
  extract: ['jsonSchema'],
  plan: ['jsonSchema', 'tools'],
  reason: ['jsonSchema', 'tools'],
  summarize: [],
  transform: [],
  vision: ['vision'],
};
