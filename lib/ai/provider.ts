// lib/ai/provider.ts — provider-agnostic LLM interface.
// Swap Anthropic / OpenAI / Gemini / local by implementing AIProvider.
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

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

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
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

/** Streamed events from an agentic run: text deltas + executed actions. */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'action'; name: string; args: Record<string, unknown>; result: unknown };

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
  /**
   * Same agentic loop as runTools, but yields incrementally: `action` events as
   * tools execute and `delta` events as the final reply streams in. Lets the UI
   * render the answer token-by-token.
   */
  runToolsStream(input: RunToolsInput): AsyncGenerator<StreamEvent>;
}

/** Build a concise Error from a non-OK OpenAI response (parses the JSON error message). */
async function openAIError(res: Response): Promise<Error> {
  let body = '';
  try {
    const bounded = await readBoundedResponseText(res, 64 * 1024);
    body = bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]';
  } catch { /* ignore */ }
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || j?.error?.code || j?.error?.type || body;
  } catch { /* not JSON */ }
  return new Error(`OpenAI error ${res.status}: ${String(detail).slice(0, 240)}`);
}

/**
 * Classify any provider/transport error into a user-facing message + short, safe
 * detail. Lets routes show the real reason (out of credits, bad key, rate limit,
 * bad model, network) instead of a blanket "something went wrong".
 */
export function describeAIError(err: unknown): { code: string; message: string; detail: string } {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const detail = raw.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer …').slice(0, 280);
  const has = (re: RegExp) => re.test(raw);
  if (has(/not configured|missing.*key|no api key/i))
    return { code: 'unconfigured', message: 'The AI engine isn’t set up yet. Add an OpenAI API key in Admin → AI Engine.', detail };
  if (has(/insufficient_quota|exceeded your current quota|billing|payment required|\b402\b/i))
    return { code: 'quota', message: 'The AI engine is out of credits. Add billing to the OpenAI account, then try again.', detail };
  if (has(/\b401\b|incorrect api key|invalid api key|invalid_api_key|unauthorized/i))
    return { code: 'auth', message: 'The AI engine’s API key is invalid. Update it in Admin → AI Engine.', detail };
  if (has(/\b429\b|rate.?limit/i))
    return { code: 'rate_limit', message: 'The AI engine is busy right now (rate limit). Wait a few seconds and try again.', detail };
  if (has(/\b404\b|does not exist|model.*not found|unknown model|unsupported model/i))
    return { code: 'model', message: 'The selected AI model isn’t available. Choose a valid model in Admin → AI Engine.', detail };
  if (has(/timeout|etimedout|econnreset|enotfound|fetch failed|network|socket hang up/i))
    return { code: 'network', message: 'Couldn’t reach the AI engine (network issue). Please try again.', detail };
  return { code: 'unknown', message: 'Something went wrong while answering. Please try again.', detail };
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
    const res = await fetchExternal('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    }, 60_000);
    if (!res.ok) throw await openAIError(res);
    const data = await readBoundedResponseJson<OpenAIChatResponse>(res, 2 * 1024 * 1024);
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
      const res = await fetchExternal('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: convo,
          // Drop tools on the final round so the model must answer in prose.
          ...(toolDefs && !last ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        }),
      }, 60_000);
      if (!res.ok) throw await openAIError(res);
      const data = await readBoundedResponseJson<OpenAIChatResponse>(res, 2 * 1024 * 1024);
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
    const res = await fetchExternal('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, messages: convo }),
    }, 60_000);
    const data = res.ok ? await readBoundedResponseJson<OpenAIChatResponse>(res, 2 * 1024 * 1024) : null;
    return { text: data?.choices?.[0]?.message?.content ?? 'Done.', actions };
  }

  async *runToolsStream({ system, messages, tools, maxTokens = 1024, maxRounds = 6 }: RunToolsInput): AsyncGenerator<StreamEvent> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const byName = new Map(tools.map((t) => [t.name, t]));
    const convo: Record<string, unknown>[] = [
      { role: 'system', content: system },
      ...messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })),
    ];
    const toolDefs = tools.length
      ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      : undefined;

    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const res = await fetchExternal('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model, max_tokens: maxTokens, messages: convo, stream: true,
          ...(toolDefs && !last ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        }),
      }, 60_000);
      if (!res.ok) throw await openAIError(res);
      if (!res.body) throw new Error('OpenAI error: no stream body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let content = '';
      const acc: Record<number, { id: string; name: string; args: string }> = {};

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          let json: { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
          try { json = JSON.parse(payload); } catch { continue; }
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) { content += delta.content; yield { type: 'delta', text: delta.content }; }
          for (const tc of delta.tool_calls ?? []) {
            const i = tc.index ?? 0;
            acc[i] ??= { id: '', name: '', args: '' };
            if (tc.id) acc[i].id = tc.id;
            if (tc.function?.name) acc[i].name = tc.function.name;
            if (tc.function?.arguments) acc[i].args += tc.function.arguments;
          }
        }
      }

      const calls = Object.values(acc).filter((c) => c.name);
      if (calls.length === 0) return; // streamed the final answer already

      convo.push({ role: 'assistant', content: content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.args || '{}'); } catch { /* ignore */ }
        const tool = byName.get(c.name);
        let result: unknown;
        try { result = tool ? await tool.execute(args) : { ok: false, error: `Unknown tool ${c.name}` }; }
        catch (e) { result = { ok: false, error: e instanceof Error ? e.message : 'Tool failed' }; }
        yield { type: 'action', name: c.name, args, result };
        convo.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
  }
}

export type AIProviderConfig = {
  provider: 'anthropic' | 'openai';   // kept for settings back-compat; OpenAI is always used
  model?: string | null;
  anthropicKey?: string | null;       // ignored — OpenAI-only deployment
  openaiKey?: string | null;
};

/** Default OpenAI model used everywhere unless an OpenAI model is configured. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/** True when `model` looks like a valid OpenAI model id (gpt-*, o1/o3/o4-*, chatgpt-*). */
function isOpenAIModel(model: string | null | undefined): model is string {
  return !!model && /^(gpt-|o\d|chatgpt-)/i.test(model);
}

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
