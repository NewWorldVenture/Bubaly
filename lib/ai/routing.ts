// lib/ai/routing.ts — task → model routing.
//
// WHY: before this, one model id from `app_settings.ai_provider` served every
// call, and the modules that wanted something different (guardian screening,
// voice) hardcoded their own — so cost and capability decisions were scattered
// across files and invisible to the admin. Routing centralises the choice: a
// call site says WHAT KIND of work it is (`classify`, `plan`, `vision`) and this
// module decides which model does it. No call site should ever name a model id.
//
// Precedence for each task: env `AI_MODEL_<TASK>` → `app_settings.ai_provider`
// `.models[task]` → the per-task default in lib/ai/models.ts. Env wins so an
// incident can be steered without a database write.
//
// An explicitly configured model that cannot do the job (a `gpt-3.5-turbo`
// routed to `plan`, which needs strict json_schema; anything not on the
// allow-list at all) is REJECTED rather than used: sending a strict schema to a
// model that ignores it produces prose the planner then mis-parses, which is the
// exact failure §5 forbids. The rejection is logged and the next source in the
// precedence chain is used, so a typo degrades to the sane default instead of
// taking the assistant down.

import {
  DEFAULT_TASK_MODELS,
  TASK_REQUIREMENTS,
  modelCapabilities,
  type AITask,
  type ModelCapabilities,
} from '@/lib/ai/models';
import { OpenAIProvider, type AIProvider } from '@/lib/ai/provider';
import { isProviderStubEnabled, scriptedProvider } from '@/lib/ai/provider-stub';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type { AITask } from '@/lib/ai/models';
export { AI_TASKS, DEFAULT_TASK_MODELS, TASK_REQUIREMENTS } from '@/lib/ai/models';

/** Why a candidate model was not used, kept for logging and the admin surface. */
export type RejectedModel = { model: string; source: ModelSource; reason: string };

export type ModelSource = 'env' | 'settings' | 'default';

export type ModelResolution = {
  task: AITask;
  model: string;
  source: ModelSource;
  capabilities: ModelCapabilities | null;
  rejected: RejectedModel[];
};

/** Environment variable that overrides the model for a task, e.g. AI_MODEL_PLAN. */
export function taskEnvVar(task: AITask): string {
  return `AI_MODEL_${task.toUpperCase()}`;
}

/**
 * Whether `model` can do `task`. Returns the reason it cannot, so callers can log
 * something a human can act on instead of a bare boolean.
 */
export function checkModelForTask(model: string, task: AITask): { ok: true; capabilities: ModelCapabilities } | { ok: false; reason: string } {
  const capabilities = modelCapabilities(model);
  if (!capabilities) return { ok: false, reason: 'not on the model allow-list in lib/ai/models.ts' };
  const missing = TASK_REQUIREMENTS[task].filter((requirement) => !capabilities[requirement]);
  if (missing.length) return { ok: false, reason: `missing ${missing.join(', ')} support` };
  return { ok: true, capabilities };
}

/**
 * Pure resolver: given the env and the stored per-task model, decide which model
 * runs `task`. Kept free of I/O so the precedence and allow-list rules are unit
 * testable without a database or a live environment.
 */
export function resolveModelForTask(
  task: AITask,
  sources: { env?: Record<string, string | undefined>; configured?: string | null } = {},
): ModelResolution {
  const env = sources.env ?? process.env;
  const rejected: RejectedModel[] = [];
  const candidates: { model: string; source: ModelSource }[] = [];

  const fromEnv = env[taskEnvVar(task)]?.trim();
  if (fromEnv) candidates.push({ model: fromEnv, source: 'env' });
  const fromSettings = sources.configured?.trim();
  if (fromSettings) candidates.push({ model: fromSettings, source: 'settings' });
  candidates.push({ model: DEFAULT_TASK_MODELS[task], source: 'default' });

  for (const candidate of candidates) {
    const check = checkModelForTask(candidate.model, task);
    if (check.ok) return { task, model: candidate.model, source: candidate.source, capabilities: check.capabilities, rejected };
    rejected.push({ ...candidate, reason: check.reason });
    console.error(`[ai-routing] ${candidate.source} model "${candidate.model}" rejected for task "${task}": ${check.reason}`);
  }

  // Every candidate failed, including the default — only reachable if the
  // defaults table and the capability table disagree. Use the default anyway so
  // the call still happens, and make the inconsistency loud.
  const fallback = DEFAULT_TASK_MODELS[task];
  console.error(`[ai-routing] no model satisfies task "${task}"; falling back to ${fallback}`);
  return { task, model: fallback, source: 'default', capabilities: modelCapabilities(fallback), rejected };
}

type StoredAIProvider = { model?: string | null; openaiKey?: string | null; models?: Partial<Record<AITask, string | null>> };
type ConfigReadOptions = { db?: SupabaseClient<Database>; failClosed?: boolean; signal?: AbortSignal };

/**
 * Read the stored per-task model map. `getAIConfig` (lib/ai/settings.ts) does not
 * expose `models`, so the row is read directly here; it is the same
 * `app_settings.ai_provider` value the admin form writes.
 */
async function readStoredConfig(options: ConfigReadOptions = {}): Promise<StoredAIProvider> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/server');
    let query = (options.db ?? createServiceClient())
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_provider');
    if (options.signal) query = query.abortSignal(options.signal);
    const { data, error } = await query.maybeSingle();
    if (error) {
      if (options.failClosed) throw error;
      console.error('[ai-routing] app_settings read failed; using env + defaults', error);
      return {};
    }
    return (data?.value ?? {}) as StoredAIProvider;
  } catch (error) {
    if (options.failClosed) {
      console.error('[ai-routing] app_settings read failed', error);
      throw new Error('AI settings are temporarily unavailable');
    }
    console.error('[ai-routing] app_settings unavailable; using env + defaults', error);
    return {};
  }
}

/** Resolve the model for a task using env + stored settings. */
export async function resolveModelForTaskFromSettings(task: AITask): Promise<ModelResolution> {
  const stored = await readStoredConfig();
  return resolveModelForTask(task, { configured: stored.models?.[task] ?? null });
}

/**
 * The provider every task-aware call site should use. The API key still comes
 * from the single admin setting (or `OPENAI_API_KEY`); only the model varies.
 */
export async function resolveProviderForTask(task: AITask, options: ConfigReadOptions = {}): Promise<AIProvider> {
  // CI and e2e runs script the model (lib/ai/provider-stub.ts). The guard
  // inside `isProviderStubEnabled` is what keeps this out of production.
  if (isProviderStubEnabled()) return scriptedProvider();
  const stored = await readStoredConfig(options);
  const { model } = resolveModelForTask(task, { configured: stored.models?.[task] ?? null });
  return new OpenAIProvider(model, stored.openaiKey || process.env.OPENAI_API_KEY || '');
}
