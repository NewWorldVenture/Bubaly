'use server';

import { revalidatePath } from 'next/cache';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { setAIConfig, type AIEngine } from '@/lib/ai/settings';

export async function saveAIConfigAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) return { ok: false, error: 'Forbidden' };

  const provider = (String(formData.get('provider')) === 'openai' ? 'openai' : 'anthropic') as AIEngine;
  const model = String(formData.get('model') || '').trim() || null;
  const anthropicKey = String(formData.get('anthropicKey') || '');
  const openaiKey = String(formData.get('openaiKey') || '');

  try {
    await setAIConfig(createServiceClient(), { provider, model, anthropicKey, openaiKey }, user.id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save' };
  }
  revalidatePath('/admin/ai');
  return { ok: true };
}
