// lib/ai/provider.ts — provider-agnostic LLM interface.
// Swap Anthropic / OpenAI / Gemini / local by implementing AIProvider.
import { modelCapabilities } from '@/lib/ai/models';
import { fenceUntrustedBlock } from '@/lib/ai/safety/untrusted';
import { isProviderStubEnabled, scriptedProvider } from '@/lib/ai/provider-stub';
import { usageFromOpenAI, type TokenUsage } from '@/lib/ai/usage';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';
import { describeActionError } from '@/lib/supabase/errors';

export type AITool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AIImage = {
  media_type: string;   // e.g. 'image/jpeg', 'image/png'
  data: string;         // base64-encoded image bytes
};

export type AIFile = {
  media_type: 'application/pdf';
  data: string;
  filename: string;
};

export type AIMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: AIImage[];   // optional vision input (user messages only)
  files?: AIFile[];     // optional PDF input, encoded by the provider transport
  tool_calls?: { name: string; args: Record<string, unknown> }[];
  tool_results?: { name: string; result: unknown }[];
};

export type AICompletion = {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  /** Token counts reported by the provider, or null when it sent none. */
  usage?: TokenUsage | null;
  /**
   * Which model actually answered. §33 asks a record to say which model ran, and
   * only the provider knows: a caller naming its own constant records the model
   * it INTENDED, which is exactly the wrong answer after a fallback or a config
   * change. Optional so a stub provider need not invent one.
   */
  model?: string;
};

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: unknown;
};

/** A tool the model can call, paired with a server-side executor. */
/**
 * A tool result on its way back to the model.
 *
 * The context builder fences every household string it puts in the SYSTEM
 * prompt (§44) — and then the same hostile calendar title arrived one turn
 * later, unfenced, as the JSON body of a `calendar.searchEvents` result. A
 * tool result is household and third-party data exactly like a context row, so
 * it carries the same fence and the same nonce guarantee.
 */
function fenceToolResult(name: string, result: unknown): string {
  return fenceUntrustedBlock(`tool_result_${name}`, JSON.stringify(result), 12_000);
}

export type ToolSpec = AITool & {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

/** A tool the model actually invoked this turn, with its result. */
export type ExecutedAction = { name: string; args: Record<string, unknown>; result: unknown };

export type ToolRunResult = { text: string; actions: ExecutedAction[]; usage?: TokenUsage | null };

export type RunToolsInput = {
  system: string;
  messages: AIMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Safety cap on tool-call rounds. Default 6. */
  maxRounds?: number;
  /** Caller cancellation. Combined with the transport deadline, never replacing it. */
  signal?: AbortSignal;
  /** Fired once per model round with that round's token counts (see lib/ai/usage.ts). */
  onUsage?: (usage: TokenUsage) => void;
};

function toolExecutionFailure(name: string, error: unknown): { ok: false; error: string } {
  console.error(`[ai-tool] ${name} failed`, error);
  return { ok: false, error: describeActionError(error, 'That assistant action could not be completed. Please try again.') };
}

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
  /** Caller cancellation. Combined with the transport deadline, never replacing it. */
  signal?: AbortSignal;
};

/** A strict-JSON-schema completion request. The schema is JSON Schema, not zod. */
export type AIStructuredInput = {
  system: string;
  messages: AIMessage[];
  /** Schema name OpenAI echoes back; must match /^[a-zA-Z0-9_-]+$/. */
  schemaName: string;
  /** Strict JSON Schema — build it with lib/ai/schema-to-json.ts. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
};

/**
 * The raw structured turn. Validation belongs to the caller (lib/ai/structured.ts)
 * so the provider stays schema-library agnostic. `refusal` is OpenAI's explicit
 * "I won't answer that" channel and is never valid JSON — it must be surfaced,
 * not parsed.
 */
export type AIStructuredCompletion = { text: string; refusal: string | null; usage: TokenUsage | null };

/**
 * The text emitted when a stream breaks after tools have already run and even the
 * tool-free recovery summary fails. Callers must never re-run the tool loop in
 * that situation (see `runToolsStream`), so the provider always produces closing
 * text of its own.
 */
export const STREAM_INTERRUPTED_AFTER_ACTIONS =
  'I finished those updates, but the connection dropped before I could write the summary.';

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
   *
   * INVARIANT (§29, duplicate-write hazard): once any tool has executed, this
   * generator never throws — it always yields at least one `delta` and returns
   * normally. Callers historically fell back to a full non-streaming `runTools`
   * run whenever the stream produced no text, which re-executed every tool the
   * broken stream had already run and double-wrote the family's data. Throwing
   * only before the first tool call keeps that fallback safe.
   */
  runToolsStream(input: RunToolsInput): AsyncGenerator<StreamEvent>;
  /**
   * One turn constrained to a strict JSON schema. Agent decisions must never be
   * regex-scraped out of prose (§5), so planners and classifiers go through here.
   */
  structuredCompletion(input: AIStructuredInput): Promise<AIStructuredCompletion>;
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
  const error = new Error(`OpenAI error ${res.status}: ${String(detail).slice(0, 240)}`);
  // lib/ai/retry.ts reads `status` first and only falls back to the message, so a
  // status carried on the error survives any future message rewording.
  Object.defineProperty(error, 'status', { value: res.status, enumerable: false });
  return error;
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
  if (err instanceof Error && err.name === 'AbortError')
    return { code: 'cancelled', message: 'That request was cancelled.', detail };
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

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TIMEOUT_MS = 60_000;
const OPENAI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function messageContent(message: AIMessage) {
  if (!message.images?.length && !message.files?.length) return message.content;
  return [
    { type: 'text' as const, text: message.content },
    ...(message.images ?? []).map((image) => ({
      type: 'image_url' as const,
      image_url: { url: `data:${image.media_type};base64,${image.data}` },
    })),
    ...(message.files ?? []).map((file) => ({
      type: 'file' as const,
      file: { filename: file.filename, file_data: `data:${file.media_type};base64,${file.data}` },
    })),
  ];
}

/**
 * Combine a caller's cancellation with the transport deadline. Returning
 * undefined lets `fetchExternal` install its own timeout, so a caller that
 * passes no signal keeps exactly the previous behaviour.
 */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!signal) return undefined;
  const combine = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof combine !== 'function') return signal;
  return combine.call(AbortSignal, [signal, AbortSignal.timeout(timeoutMs)]);
}

// --- OpenAI (ChatGPT) implementation ---
export class OpenAIProvider implements AIProvider {
  id = 'openai';
  constructor(public model = 'gpt-4o', private apiKey = process.env.OPENAI_API_KEY ?? '') {}

  /**
   * o-series Chat Completions reject `max_tokens` and require
   * `max_completion_tokens`; sending the wrong one 400s every call for a model
   * the admin dropdown happily offers (`lib/ai/models.ts` lists `o4-mini`).
   */
  private tokenParam(): 'max_tokens' | 'max_completion_tokens' {
    return modelCapabilities(this.model)?.maxTokensParam ?? (/^o\d/i.test(this.model) ? 'max_completion_tokens' : 'max_tokens');
  }

  private chatBody(body: Record<string, unknown>, maxTokens: number): string {
    return JSON.stringify({ model: this.model, [this.tokenParam()]: maxTokens, ...body });
  }

  private post(body: string, signal?: AbortSignal): Promise<Response> {
    return fetchExternal(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body,
      signal: withDeadline(signal, OPENAI_TIMEOUT_MS),
    }, OPENAI_TIMEOUT_MS);
  }

  async complete({ system, messages, tools, maxTokens = 1024, signal }: AICompleteInput): Promise<AICompletion> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const body: Record<string, unknown> = {
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: messageContent(m) })),
      ],
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    const res = await this.post(this.chatBody(body, maxTokens), signal);
    if (!res.ok) throw await openAIError(res);
    const data = await readBoundedResponseJson<OpenAIChatResponse>(res, OPENAI_MAX_RESPONSE_BYTES);
    const msg = data.choices?.[0]?.message ?? {};
    const text = msg.content ?? '';
    const toolCalls = (msg.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* ignore */ }
      return { name: c.function.name, args };
    });
    return { text, toolCalls, usage: usageFromOpenAI(data.usage), model: this.model };
  }

  async structuredCompletion({ system, messages, schemaName, jsonSchema, maxTokens = 1024, signal }: AIStructuredInput): Promise<AIStructuredCompletion> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const caps = modelCapabilities(this.model);
    if (caps && !caps.jsonSchema) {
      // Fail loudly rather than degrade to json_object: silently dropping the
      // schema is how free-text parsing crept back in everywhere else.
      throw new Error(`OpenAI error 400: model ${this.model} does not support strict json_schema output`);
    }
    const body = this.chatBody({
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: messageContent(m) })),
      ],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: jsonSchema } },
    }, maxTokens);
    const res = await this.post(body, signal);
    if (!res.ok) throw await openAIError(res);
    const data = await readBoundedResponseJson<OpenAIChatResponse>(res, OPENAI_MAX_RESPONSE_BYTES);
    const msg = data.choices?.[0]?.message ?? {};
    return { text: msg.content ?? '', refusal: msg.refusal ?? null, usage: usageFromOpenAI(data.usage) };
  }

  async runTools({ system, messages, tools, maxTokens = 1024, maxRounds = 6, signal, onUsage }: RunToolsInput): Promise<ToolRunResult> {
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
    let total: TokenUsage | null = null;
    const account = (usage: TokenUsage | null) => {
      if (!usage) return;
      onUsage?.(usage);
      total = total
        ? { inputTokens: total.inputTokens + usage.inputTokens, outputTokens: total.outputTokens + usage.outputTokens, totalTokens: total.totalTokens + usage.totalTokens }
        : usage;
    };

    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      const res = await this.post(this.chatBody({
        messages: convo,
        // Drop tools on the final round so the model must answer in prose.
        ...(toolDefs && !last ? { tools: toolDefs, tool_choice: 'auto' } : {}),
      }, maxTokens), signal);
      if (!res.ok) throw await openAIError(res);
      const data = await readBoundedResponseJson<OpenAIChatResponse>(res, OPENAI_MAX_RESPONSE_BYTES);
      account(usageFromOpenAI(data.usage));
      const msg = data.choices?.[0]?.message ?? {};
      const calls: { id: string; function: { name: string; arguments: string } }[] = msg.tool_calls ?? [];

      if (!calls.length) return { text: msg.content ?? '', actions, usage: total };

      // Record the assistant turn (with its tool_calls) then execute each call.
      convo.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }
        const tool = byName.get(call.function.name);
        let result: unknown;
        try { result = tool ? await tool.execute(args) : { ok: false, error: `Unknown tool ${call.function.name}` }; }
        catch (e) { result = toolExecutionFailure(call.function.name, e); }
        actions.push({ name: call.function.name, args, result });
        convo.push({ role: 'tool', tool_call_id: call.id, content: fenceToolResult(call.function.name, result) });
      }
    }
    // Exhausted rounds — ask once more for a plain summary.
    const res = await this.post(this.chatBody({ messages: convo }, maxTokens), signal);
    const data = res.ok ? await readBoundedResponseJson<OpenAIChatResponse>(res, OPENAI_MAX_RESPONSE_BYTES) : null;
    account(usageFromOpenAI(data?.usage));
    return { text: data?.choices?.[0]?.message?.content ?? 'Done.', actions, usage: total };
  }

  /**
   * One tool-free, non-streaming turn used to close out a run whose stream died
   * after tools had already executed. Sending no tools is what makes it safe:
   * the model physically cannot re-run a write that already happened.
   */
  private async closingSummary(convo: Record<string, unknown>[], maxTokens: number, signal?: AbortSignal): Promise<string> {
    try {
      const res = await this.post(this.chatBody({ messages: convo }, maxTokens), signal);
      if (!res.ok) return '';
      const data = await readBoundedResponseJson<OpenAIChatResponse>(res, OPENAI_MAX_RESPONSE_BYTES);
      return data.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      console.error('[ai-provider] closing summary after stream failure failed', error);
      return '';
    }
  }

  async *runToolsStream({ system, messages, tools, maxTokens = 1024, maxRounds = 6, signal, onUsage }: RunToolsInput): AsyncGenerator<StreamEvent> {
    if (!this.apiKey) throw new Error('OpenAI API key is not configured');
    const byName = new Map(tools.map((t) => [t.name, t]));
    const convo: Record<string, unknown>[] = [
      { role: 'system', content: system },
      ...messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })),
    ];
    const toolDefs = tools.length
      ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      : undefined;
    // Tools executed so far in THIS run. Everything about failure handling below
    // keys off this counter: before the first execution a caller may safely retry
    // the whole turn, after it a retry would double-write.
    let executed = 0;

    for (let round = 0; round < maxRounds; round++) {
      const last = round === maxRounds - 1;
      let content = '';
      let calls: { id: string; name: string; args: string }[] = [];

      try {
        const res = await this.post(this.chatBody({
          messages: convo,
          stream: true,
          // Streamed responses omit `usage` unless it is asked for explicitly.
          stream_options: { include_usage: true },
          ...(toolDefs && !last ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        }, maxTokens), signal);
        if (!res.ok) throw await openAIError(res);
        if (!res.body) throw new Error('OpenAI error: no stream body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
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
            let json: {
              usage?: unknown;
              choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            };
            try { json = JSON.parse(payload); } catch { continue; }
            // The usage chunk arrives last and carries an empty `choices` array.
            if (json.usage) { const u = usageFromOpenAI(json.usage); if (u) onUsage?.(u); }
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
        calls = Object.values(acc).filter((c) => c.name);
      } catch (streamError) {
        // Nothing has been written yet: the caller's retry/fallback is safe, so
        // give it the real error.
        if (executed === 0) throw streamError;
        // Tools already ran. Re-running the loop here (or letting the caller do
        // it, which it will if we hand back no text) would execute those writes a
        // second time. Close the turn ourselves with a tool-free summary instead.
        console.error('[ai-provider] stream failed after tools executed; closing without re-running them', streamError);
        const summary = await this.closingSummary(convo, maxTokens, signal);
        yield { type: 'delta', text: summary || STREAM_INTERRUPTED_AFTER_ACTIONS };
        return;
      }

      if (calls.length === 0) return; // streamed the final answer already

      convo.push({ role: 'assistant', content: content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.args || '{}'); } catch { /* ignore */ }
        const tool = byName.get(c.name);
        let result: unknown;
        try { result = tool ? await tool.execute(args) : { ok: false, error: `Unknown tool ${c.name}` }; }
        catch (e) { result = toolExecutionFailure(c.name, e); }
        executed += 1;
        yield { type: 'action', name: c.name, args, result };
        convo.push({ role: 'tool', tool_call_id: c.id, content: fenceToolResult(c.name, result) });
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
 *
 * For work with a known shape (planning, classification, vision) prefer
 * `resolveProviderForTask(task)` from lib/ai/routing.ts, which picks the right
 * model for the job instead of the one global default.
 */
export async function resolveProvider(): Promise<AIProvider> {
  // Same scripted-provider branch as `resolveProviderForTask`, so the chat
  // surface and the planner are stubbed together or not at all.
  if (isProviderStubEnabled()) return scriptedProvider();
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
  // The scripted provider (tests, CI e2e, local development only — it refuses
  // to enable itself in a Vercel production deploy) counts as configured, so
  // every surface that gates on this agrees with the routing layer.
  try {
    const { isProviderStubEnabled } = await import('@/lib/ai/provider-stub');
    if (isProviderStubEnabled()) return true;
  } catch { /* the stub module is optional */ }
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
