// lib/ai/provider-stub.ts — a scripted AIProvider for CI and end-to-end tests.
//
// WHY: §45–§47 want the AI paths exercised on every PR, and a real model in CI
// is slow, costly and — worse — non-deterministic, so a failing eval would
// never be reproducible. `ScriptedProvider` implements the same `AIProvider`
// interface the OpenAI provider does, but every reply comes from a JSON file
// under tests/ai-eval/scripts. The same request always produces the same plan,
// the same classification, the same chat reply.
//
// WHEN IT IS USED — and, more importantly, when it can never be:
//   `resolveProviderForTask` (lib/ai/routing.ts) and `resolveProvider`
//   (lib/ai/provider.ts) return it only when `isProviderStubEnabled()` says so:
//   `AI_PROVIDER_STUB=1` AND (`NODE_ENV !== 'production'` OR
//   `E2E_PROVIDER_STUB=1`), AND never when `VERCEL_ENV === 'production'`.
//   The second flag exists because Playwright runs against `next build && next
//   start`, where NODE_ENV is 'production'; it must be set deliberately, and
//   the Vercel guard is the hard floor: a production deployment cannot enable
//   the stub by any combination of variables.
//
// HOW A SCRIPT IS CHOSEN: the planner's system prompt carries an `Intent:
// <key>` line and the classifier's carries the request; a script matches on
// `match.intent` against that line or on `match.text` phrases against the
// last user message (case-insensitive substring). The first match in
// `priority` order wins, so a low-numbered guard script (prompt injection)
// beats an ordinary intent match; `answer_question` is the fallback for
// anything unmatched, so a stubbed run never hangs on a missing reply.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AICompleteInput, AICompletion, AIMessage, AIProvider, AIStructuredCompletion, AIStructuredInput,
  ExecutedAction, RunToolsInput, StreamEvent, ToolRunResult,
} from '@/lib/ai/provider';
import type { TokenUsage } from '@/lib/ai/usage';

/** Where the scripts live; overridable so a test can point at a fixture directory. */
export const DEFAULT_SCRIPT_DIR = path.join('tests', 'ai-eval', 'scripts');

export const STUB_MODEL_ID = 'scripted-stub';

/** Fixed so usage accounting is deterministic too. */
const STUB_USAGE: TokenUsage = { inputTokens: 120, outputTokens: 80, totalTokens: 200 };

export type ScriptedToolCall = { name: string; args: Record<string, unknown> };

/** One file under tests/ai-eval/scripts. */
export type ProviderScript = {
  id: string;
  /** Lower runs first; ties broken by id. Defaults to 100. */
  priority?: number;
  match?: {
    /** Planner/classifier intent keys this script answers. */
    intent?: string[];
    /** Case-insensitive substrings of the last user message. */
    text?: string[];
    /** `true` marks the fallback used when nothing else matches. */
    fallback?: boolean;
  };
  /** Structured replies keyed by `schemaName`; `*` is the default for any schema. */
  structured?: Record<string, unknown>;
  /** The reply for `complete()` and the tool loops. */
  chat?: { text: string; toolCalls?: ScriptedToolCall[] };
};

/**
 * The stub may only be selected in a non-production runtime, or in an e2e run
 * that opted in explicitly — and never on a Vercel production deployment.
 */
export function isProviderStubEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.AI_PROVIDER_STUB !== '1') return false;
  if (env.VERCEL_ENV === 'production') return false;
  return env.NODE_ENV !== 'production' || env.E2E_PROVIDER_STUB === '1';
}

function lastUserText(messages: AIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content ?? '';
  }
  return '';
}

/** The `Intent: <key>` line the planner and classifier prompts carry. */
export function intentFromSystem(system: string): string | null {
  const match = /^Intent:\s*([a-z_]+)\s*$/im.exec(system);
  return match ? match[1] : null;
}

function isScript(value: unknown): value is ProviderScript {
  return Boolean(value && typeof value === 'object' && typeof (value as ProviderScript).id === 'string');
}

/** Load every `*.json` script in a directory. A malformed file is an error, not a silent skip: a broken script is a broken test. */
export async function loadScripts(dir: string = DEFAULT_SCRIPT_DIR): Promise<ProviderScript[]> {
  const absolute = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  const names = (await readdir(absolute)).filter((name) => name.endsWith('.json')).sort();
  const scripts: ProviderScript[] = [];
  for (const name of names) {
    const raw = await readFile(path.join(absolute, name), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isScript(parsed)) throw new Error(`[provider-stub] ${name} is not a provider script (missing "id")`);
    scripts.push(parsed);
  }
  return scripts;
}

/**
 * Pick the script for a call: the first script in `priority` order (ties by
 * id, so the choice is stable) whose intent list contains the prompt's intent
 * OR whose text phrases match the last user message; the fallback script
 * when nothing does. Priority ranking across both match kinds is what lets a
 * guard script (the prompt-injection reply, priority 1) win over an intent
 * match when hostile text rides along on an ordinary request.
 */
export function selectScript(scripts: ProviderScript[], input: { system: string; messages: AIMessage[] }): ProviderScript | null {
  const intent = intentFromSystem(input.system);
  const text = lastUserText(input.messages).toLowerCase();
  const ordered = [...scripts].sort((a, b) => ((a.priority ?? 100) - (b.priority ?? 100)) || a.id.localeCompare(b.id));

  const matched = ordered.find((s) =>
    (intent !== null && (s.match?.intent ?? []).includes(intent))
    || (s.match?.text ?? []).some((phrase) => phrase && text.includes(phrase.toLowerCase())));
  if (matched) return matched;
  return ordered.find((s) => s.match?.fallback === true) ?? null;
}

export class ScriptedProvider implements AIProvider {
  readonly id = 'scripted';
  readonly model = STUB_MODEL_ID;
  private scripts: ProviderScript[] | null = null;

  constructor(private readonly dir: string = DEFAULT_SCRIPT_DIR, preloaded?: ProviderScript[]) {
    if (preloaded) this.scripts = preloaded;
  }

  private async ready(): Promise<ProviderScript[]> {
    if (!this.scripts) this.scripts = await loadScripts(this.dir);
    return this.scripts;
  }

  private async pick(input: { system: string; messages: AIMessage[] }): Promise<ProviderScript> {
    const script = selectScript(await this.ready(), input);
    if (!script) throw new Error('[provider-stub] no script matches this call and no fallback script is defined');
    return script;
  }

  async complete({ system, messages }: AICompleteInput): Promise<AICompletion> {
    const script = await this.pick({ system, messages });
    return { text: script.chat?.text ?? '', toolCalls: script.chat?.toolCalls ?? [], usage: STUB_USAGE };
  }

  async structuredCompletion({ system, messages, schemaName }: AIStructuredInput): Promise<AIStructuredCompletion> {
    const script = await this.pick({ system, messages });
    const reply = script.structured?.[schemaName] ?? script.structured?.['*'];
    if (reply === undefined) {
      throw new Error(`[provider-stub] script "${script.id}" has no structured reply for schema "${schemaName}"`);
    }
    return { text: JSON.stringify(reply), refusal: null, usage: STUB_USAGE };
  }

  /**
   * The scripted tool calls run through the REAL tool specs the caller passed,
   * so an e2e run exercises the trust gate, the ledger and the services — only
   * the model's decision is canned.
   */
  async runTools({ system, messages, tools, onUsage }: RunToolsInput): Promise<ToolRunResult> {
    const script = await this.pick({ system, messages });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const actions: ExecutedAction[] = [];
    for (const call of script.chat?.toolCalls ?? []) {
      const tool = byName.get(call.name);
      let result: unknown;
      try {
        result = tool ? await tool.execute(call.args) : { ok: false, error: `Unknown tool ${call.name}` };
      } catch (error) {
        console.error(`[provider-stub] scripted tool ${call.name} threw`, error);
        result = { ok: false, error: `${call.name} failed.` };
      }
      actions.push({ name: call.name, args: call.args, result });
    }
    onUsage?.(STUB_USAGE);
    return { text: script.chat?.text ?? '', actions, usage: STUB_USAGE };
  }

  async *runToolsStream(input: RunToolsInput): AsyncGenerator<StreamEvent> {
    const result = await this.runTools(input);
    for (const action of result.actions) yield { type: 'action', name: action.name, args: action.args, result: action.result };
    if (result.text) yield { type: 'delta', text: result.text };
  }
}

let shared: ScriptedProvider | null = null;

/** The process-wide stub, so scripts are read once. Tests construct their own with a fixture directory. */
export function scriptedProvider(): ScriptedProvider {
  if (!shared) shared = new ScriptedProvider(process.env.AI_PROVIDER_STUB_DIR || DEFAULT_SCRIPT_DIR);
  return shared;
}
