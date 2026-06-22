// lib/ai/provider.ts — provider-agnostic LLM interface.
// Swap Anthropic / OpenAI / Gemini / local by implementing AIProvider.

export type AITool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AIMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: { name: string; args: Record<string, unknown> }[];
  tool_results?: { name: string; result: unknown }[];
};

export type AICompletion = {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
};

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  complete(input: {
    system: string;
    messages: AIMessage[];
    tools: AITool[];
  }): Promise<AICompletion>;
}

// --- Anthropic implementation ---
export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  constructor(public model = 'claude-sonnet-4-6', private apiKey = process.env.ANTHROPIC_API_KEY!) {}

  async complete({ system, messages, tools }: {
    system: string; messages: AIMessage[]; tools: AITool[];
  }): Promise<AICompletion> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages: messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('\n');
    const toolCalls = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'tool_use')
      .map((b: { name: string; input: Record<string, unknown> }) => ({ name: b.name, args: b.input }));
    return { text, toolCalls };
  }
}

// --- OpenAI (ChatGPT) implementation ---
export class OpenAIProvider implements AIProvider {
  id = 'openai';
  constructor(public model = 'gpt-4o', private apiKey = process.env.OPENAI_API_KEY ?? '') {}

  async complete({ system, messages, tools }: {
    system: string; messages: AIMessage[]; tools: AITool[];
  }): Promise<AICompletion> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 1024,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content })),
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
  provider: 'anthropic' | 'openai';
  model?: string | null;
  anthropicKey?: string | null;
  openaiKey?: string | null;
};

const DEFAULT_MODEL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
};

/** Build a provider from an explicit config (used by the settings-backed resolver). */
export function providerFromConfig(cfg: AIProviderConfig): AIProvider {
  const model = cfg.model || DEFAULT_MODEL[cfg.provider];
  if (cfg.provider === 'openai') {
    return new OpenAIProvider(model, cfg.openaiKey ?? process.env.OPENAI_API_KEY ?? '');
  }
  return new AnthropicProvider(model, cfg.anthropicKey ?? process.env.ANTHROPIC_API_KEY ?? '');
}

/** Env-only provider (back-compat / no DB available). */
export function getProvider(): AIProvider {
  const provider = (process.env.AI_PROVIDER ?? 'anthropic') === 'openai' ? 'openai' : 'anthropic';
  return providerFromConfig({ provider, model: process.env.AI_MODEL });
}

/**
 * Settings-backed provider resolution. Reads the admin-configured AI engine from
 * app_settings (key `ai_provider`) and falls back to environment variables.
 * Use this in route handlers so the in-app AI Engine setting takes effect.
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
