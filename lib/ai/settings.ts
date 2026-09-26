import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProviderConfig } from '@/lib/ai/provider';
import type { AIEngine, AIConfigView } from '@/lib/ai/models';

type DB = SupabaseClient<Database>;

const KEY = 'ai_provider';

export type { AIEngine, AIConfigView } from '@/lib/ai/models';
export { AI_MODELS } from '@/lib/ai/models';

type StoredConfig = {
  provider?: AIEngine;
  model?: string | null;
  anthropicKey?: string | null;
  openaiKey?: string | null;
};

/**
 * Resolve the active AI config for server use (includes real API keys).
 * Precedence: stored value (app_settings) → environment variables.
 */
export async function getAIConfig(supabase: DB): Promise<AIProviderConfig> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const stored = (data?.value ?? {}) as StoredConfig;
  // OpenAI-only deployment: provider is always 'openai' regardless of what was stored.
  return {
    provider: 'openai',
    model: stored.model || process.env.AI_MODEL || null,
    anthropicKey: stored.anthropicKey || process.env.ANTHROPIC_API_KEY || null,
    openaiKey: stored.openaiKey || process.env.OPENAI_API_KEY || null,
  };
}

/**
 * Resolve just the OpenAI API key (admin-saved value → env). Used by the voice
 * routes (transcription / TTS) which call OpenAI's audio endpoints directly.
 * Returns '' when no key is configured so callers can fail honestly with a 503.
 */
export async function getOpenAIKey(supabase: DB): Promise<string> {
  try {
    const cfg = await getAIConfig(supabase);
    return cfg.openaiKey ?? '';
  } catch {
    return process.env.OPENAI_API_KEY ?? '';
  }
}

export async function getAIConfigView(supabase: DB): Promise<AIConfigView> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const stored = (data?.value ?? {}) as StoredConfig;
  return {
    provider: 'openai',
    model: stored.model || process.env.AI_MODEL || null,
    anthropicKeySet: Boolean(stored.anthropicKey || process.env.ANTHROPIC_API_KEY),
    openaiKeySet: Boolean(stored.openaiKey || process.env.OPENAI_API_KEY),
    anthropicFromEnv: !stored.anthropicKey && Boolean(process.env.ANTHROPIC_API_KEY),
    openaiFromEnv: !stored.openaiKey && Boolean(process.env.OPENAI_API_KEY),
  };
}

/**
 * Persist AI config. Keys are only overwritten when a non-empty value is given,
 * so re-saving the form without re-entering a key preserves the stored one.
 */
export async function setAIConfig(
  supabase: DB,
  input: { provider: AIEngine; model: string | null; anthropicKey?: string; openaiKey?: string },
  actorId: string | null,
): Promise<void> {
  // Both results used to be discarded, and the caller's try/catch cannot see a
  // resolved PostgREST error:
  //  - a refused READ made `stored` empty, so a save that left a key field
  //    blank ("keep the stored one", as the docstring promises) wrote that key
  //    as NULL — wiping the platform's AI key from a model change;
  //  - a refused WRITE was reported to the admin as saved.
  // Both throw now, which the admin action already turns into a message.
  // Audit C1-S9-76.
  const { data, error: readError } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (readError) throw readError;
  const stored = (data?.value ?? {}) as StoredConfig;
  const next: StoredConfig = {
    provider: 'openai',   // OpenAI-only deployment
    model: input.model || null,
    anthropicKey: input.anthropicKey?.trim() ? input.anthropicKey.trim() : stored.anthropicKey ?? null,
    openaiKey: input.openaiKey?.trim() ? input.openaiKey.trim() : stored.openaiKey ?? null,
  };
  const { error: writeError } = await supabase.from('app_settings').upsert(
    { key: KEY, value: next as unknown as Database['public']['Tables']['app_settings']['Insert']['value'], updated_by: actorId },
    { onConflict: 'key' },
  );
  if (writeError) throw writeError;
}
