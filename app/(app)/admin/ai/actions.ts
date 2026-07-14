'use server';

import { revalidatePath } from 'next/cache';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { setAIConfig } from '@/lib/ai/settings';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { describeActionError } from '@/lib/supabase/errors';

export async function saveAIConfigAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) return { ok: false, error: 'Forbidden' };

  // OpenAI-only deployment.
  const model = String(formData.get('model') || '').trim() || null;
  const openaiKey = String(formData.get('openaiKey') || '');

  try {
    await setAIConfig(createServiceClient(), { provider: 'openai', model, openaiKey }, user.id);
  } catch (e) {
    console.error('[admin-ai] config save failed', e);
    return { ok: false, error: describeActionError(e, 'Could not save AI settings.') };
  }
  revalidatePath('/admin/ai');
  return { ok: true };
}

export type TestAIResult =
  | { ok: true; model: string; reply: string; latencyMs: number }
  | { ok: false; code: string; message: string; detail: string };

/**
 * Ping the live AI engine with a tiny prompt so an admin can verify the API key,
 * model, and billing are actually working — surfacing the precise reason on
 * failure (out of credits, bad key, bad model, rate limit, network).
 */
export async function testAIConnectionAction(): Promise<TestAIResult> {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) return { ok: false, code: 'forbidden', message: 'Forbidden', detail: '' };

  if (!(await isAIConfigured())) {
    return { ok: false, code: 'unconfigured', message: 'No OpenAI key configured. Add one above and save, then test again.', detail: '' };
  }

  try {
    const provider = await resolveProvider();
    const startedAt = Date.now();
    const completion = await provider.complete({
      system: 'You are a connection test. Reply with exactly: OK',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      maxTokens: 5,
    });
    const latencyMs = Date.now() - startedAt;
    const reply = completion.text.trim() || '(empty reply)';
    return { ok: true, model: provider.model, reply, latencyMs };
  } catch (err) {
    console.error('AI connection test failed:', err);
    const { code, message, detail } = describeAIError(err);
    return { ok: false, code, message, detail };
  }
}
