// lib/ai/provider.ts — provider-agnostic LLM interface.
// Swap Anthropic / OpenAI / Gemini / local by implementing AIProvider.

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

/** A tool the model can call, paired with a server-side executor. */
export type ToolSpec = AITool & {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

/** A tool the model actually invoked this turn, with its result. */
export type ExecutedAction = { name: string; args: Record<string, unknown>; result: unknown };

export type ToolRunResult = { text: string; actions: ExecutedAction[] };

export type RunToolsInput = {
  system: string;
  messages: AIMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Safety cap on tool-call rounds. Default 6. */
  maxRounds?: number;
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
  /**
   * Run an agentic tool loop: the model may call tools, we execute them and feed
   * the results back, repeating until it produces a final natural-language reply.
   * Returns that reply + the list of actions actually taken.
   */
  runTools(input: RunToolsInput): Promise<ToolRunResult>;
}

// --- Anthropic implementation ---
export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  constructor(public model = 'claude-sonnet-4-6', private apiKey = process.env.ANTHROPIC_API_KEY!) {}

  async complete({ system, messages, tools, maxTokens = 1024 }: AICompleteInput): Promise<AICompletion> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages: messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            // Attach vision blocks when a message carries images (user only).
            if (m.images?.length) {
              return {
                role: m.role,
                content: [
                  ...m.images.map((img) => ({
                    type: 'image' as const,
                    source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
                  })),
                  { type: 'text' as const, text: m.content },
                ],
              };
            }
            return { role: m.role, content: m.content };
          }),
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

  async runTools({ system, messages, tools, maxTokens = 1024, maxRounds = 6 }: RunToolsInput): Promise<ToolRunResult> {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const convo: { role: 'user' | 'assistant'; content: unknown }[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const actions: ExecutedAction[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.model, max_tokens: maxTokens, system, tools: toolDefs, messages: convo }),
      });
      if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const blocks: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] = data.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const uses = blocks.filter((b) => b.type === 'tool_use');

      if (data.stop_reason !== 'tool_use' || uses.length === 0) return { text, actions };

      convo.push({ role: 'assistant', content: blocks });
      const results: unknown[] = [];
      for (const use of uses) {
        const tool = byName.get(use.name ?? '');
        let result: unknown;
        try { result = tool ? await tool.execute(use.input ?? {}) : { ok: false, error: `Unknown tool ${use.name}` }; }
        catch (e) { result = { ok: false, error: e instanceof Error ? e.message : 'Tool failed' }; }
        actions.push({ name: use.name ?? 'tool', args: use.input ?? {}, result });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
      }
      convo.push({ role: 'user', content: results });
    }
    return { text: 'Done.', actions };
  }
}

// --- OpenAI (ChatGPT) implementation ---
export class OpenAIProvider implements AIProvider {
  id = 'openai';
  constructor(public model = 'gpt-4o', private apiKey = process.env.OPENAI_API_KEY ?? '') {}

  async complete({ system, messages, tools, maxTokens = 1024 }: AICompleteInput): Promise<AICompletion> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
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

  async runTools({ system, messages, tools, maxTokens = 1024, maxRounds = 6 }: RunToolsInput): Promise<ToolRunResult> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const byName = new Map(tools.map((t) => [t.name, t]));
    // OpenAI's running message log (native function-calling format).
    const convo: Record<string, unknown>[] = [
      { role: 'system', content: system },
      ...messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content })),
    ];
    const toolDefs = tools.length
      ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      : undefined;
    const actions: ExecutedAction[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: convo,
          // Drop tools on the final round so the model must answer in prose.
          ...(toolDefs && !last ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        }),
      });
      if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      const calls: { id: string; function: { name: string; arguments: string } }[] = msg.tool_calls ?? [];

      if (!calls.length) return { text: msg.content ?? '', actions };

      // Record the assistant turn (with its tool_calls) then execute each call.
      convo.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }
        const tool = byName.get(call.function.name);
        let result: unknown;
        try { result = tool ? await tool.execute(args) : { ok: false, error: `Unknown tool ${call.function.name}` }; }
        catch (e) { result = { ok: false, error: e instanceof Error ? e.message : 'Tool failed' }; }
        actions.push({ name: call.function.name, args, result });
        convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    // Exhausted rounds — ask once more for a plain summary.
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, messages: convo }),
    });
    const data = res.ok ? await res.json() : null;
    return { text: data?.choices?.[0]?.message?.content ?? 'Done.', actions };
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
