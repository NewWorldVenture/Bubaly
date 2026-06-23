// lib/ai/provider.ts — provider-agnostic LLM interface.
// This deployment is OpenAI-only: every AI route and helper resolves to ChatGPT
// (OpenAI). The provider abstraction is kept so a future engine could be added,
// but `providerFromConfig`/`getProvider`/`resolveProvider` always return OpenAI.

export type AITool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AIImage = {
  media_type: string;   // e.g. 'image/jpeg', 'image/png'
  data: string;         // base64-encoded image bytes
};

export type AIMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: AIImage[];   // optional vision input (user messages only)
  tool_calls?: { name: string; args: Record<string, unknown> }[];
  tool_results?: { name: string; result: unknown }[];
};

export type AICompletion = {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
};

export type AICompleteInput = {
  system: string;
  messages: AIMessage[];
  tools: AITool[];
  /** Max output tokens. Defaults to 1024. */
  maxTokens?: number;
};

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  complete(input: AICompleteInput): Promise<AICompletion>;
}

/** Default OpenAI model used everywhere unless an OpenAI model is configured. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/** True when `model` looks like a valid OpenAI model id (gpt-*, o1/o3/o4-*, chatgpt-*). */
function isOpenAIModel(model: string | null | undefined): model is string {
  return !!model && /^(gpt-|o\d|chatgpt-)/i.test(model);
}

// --- OpenAI (ChatGPT) implementation ---
export class OpenAIProvider implements AIProvider {
  id = 'openai';
  constructor(public model = DEFAULT_OPENAI_MODEL, private apiKey = process.env.OPENAI_API_KEY ?? '') {}

  async complete({ system, messages, tools, maxTokens = 1024 }: AICompleteInput): Promise<AICompletion> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            // Attach vision blocks when a user message carries images.
            if (m.images?.length) {
              return {
                role: m.role,
                content: [
                  { type: 'text' as const, text: m.content },
                  ...m.images.map((img) => ({
                    type: 'image_url' as const,
                    image_url: { url: `data:${img.media_type};base64,${img.data}` },
                  })),
                ],
              };
            }
            return { role: m.role, content: m.content };
          }),
      ],
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const text = msg.content ?? '';
    const toolCalls = (msg.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* ignore */ }
      return { name: c.function.name, args };
    });
    return { text, toolCalls };
  }
}

export type AIProviderConfig = {
  provider: 'anthropic' | 'openai';   // kept for settings back-compat; OpenAI is always used
  model?: string | null;
  anthropicKey?: string | null;       // ignored — OpenAI-only deployment
  openaiKey?: string | null;
};

/**
 * Build a provider from config. OpenAI-only: the `provider` field is ignored and
 * any stored non-OpenAI model is replaced with the default OpenAI model so a
 * previously-saved Claude model can never break a call.
 */
export function providerFromConfig(cfg: AIProviderConfig): AIProvider {
  const model = isOpenAIModel(cfg.model) ? cfg.model : DEFAULT_OPENAI_MODEL;
  return new OpenAIProvider(model, cfg.openaiKey ?? process.env.OPENAI_API_KEY ?? '');
}

/** Env-only provider (no DB available). Always OpenAI. */
export function getProvider(): AIProvider {
  return new OpenAIProvider(
    isOpenAIModel(process.env.AI_MODEL) ? process.env.AI_MODEL : DEFAULT_OPENAI_MODEL,
    process.env.OPENAI_API_KEY ?? '',
  );
}

/**
 * Settings-backed provider resolution. Reads the admin-configured OpenAI key +
 * model from app_settings (key `ai_provider`) and falls back to environment
 * variables. Always returns an OpenAI provider.
 */
export async function resolveProvider(): Promise<AIProvider> {
  try {
    const { getAIConfig } = await import('@/lib/ai/settings');
    const { createServiceClient } = await import('@/lib/supabase/server');
    const cfg = await getAIConfig(createServiceClient());
    return providerFromConfig(cfg);
  } catch {
    return getProvider();
  }
}

/**
 * Whether OpenAI is configured (env var or an admin-saved key). Use in routes to
 * fast-fail with an honest 503 before doing any work.
 */
export async function isAIConfigured(): Promise<boolean> {
  if (process.env.OPENAI_API_KEY) return true;
  try {
    const { getAIConfig } = await import('@/lib/ai/settings');
    const { createServiceClient } = await import('@/lib/supabase/server');
    const cfg = await getAIConfig(createServiceClient());
    return !!cfg.openaiKey;
  } catch {
    return false;
  }
}
