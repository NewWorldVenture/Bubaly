'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { superAdminGate } from '@/lib/auth/super-admin-gate';
import { createServiceClient } from '@/lib/supabase/server';
import { setAIConfig } from '@/lib/ai/settings';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { describeActionError } from '@/lib/supabase/errors';
import { logAudit } from '@/lib/server/audit';

export async function saveAIConfigAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const gate = await superAdminGate();
  if (gate.status !== 'allowed') {
    const error = gate.status === 'unavailable' ? t('ai.accountContextIsTemporarilyUnavailable')
      : gate.status === 'step_up' ? t('actions.adminConsoleNeedsYourCode') : t('actions.forbidden');
    return { ok: false, error };
  }
  const { user } = gate;

  // OpenAI-only deployment.
  const model = String(formData.get('model') || '').trim() || null;
  const openaiKey = String(formData.get('openaiKey') || '');

  const service = createServiceClient();
  try {
    await setAIConfig(service, { provider: 'openai', model, openaiKey }, user.id);
  } catch (e) {
    console.error('[admin-ai] config save failed', e);
    return { ok: false, error: describeActionError(e, t('actions.couldNotSaveAiSettings')) };
  }
  // app_settings.updated_by is overwritten by the next save, so it is not a
  // history. The key itself is never logged, only whether one was set.
  await logAudit(service, {
    familyId: null, actorId: user.id, action: 'update', resource: 'app_settings', resourceId: null,
    metadata: { setting_key: 'ai_provider', provider: 'openai', model, key_changed: Boolean(openaiKey.trim()), via: 'site_admin' },
  });
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
  const t = await getTranslations();
  const gate = await superAdminGate();
  if (gate.status === 'unavailable') return { ok: false, code: 'unavailable', message: t('ai.accountContextIsTemporarilyUnavailable'), detail: '' };
  if (gate.status !== 'allowed') return { ok: false, code: 'forbidden', message: t('actions.forbidden'), detail: '' };

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
