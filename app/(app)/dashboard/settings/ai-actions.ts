'use server';

// Settings → Bubaly AI. The server half: read the family's settings for the
// panel, and save a manager's changes.
//
// Both go through `lib/services/ai-settings`, which is where the manager check
// and the validation live — an action that trusted its input would be the one
// place a child could widen what the AI may do, and the service is also what
// the tool gate reads, so page and gate can never disagree about the rules.
import { revalidatePath } from 'next/cache';
import { scopeFromUserContext } from '@/lib/services/scope';
import { getAISettings, updateAISettings, type AISettingsPatch } from '@/lib/services/ai-settings';
import type { AISettings } from '@/lib/ai/family-settings';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';

export type AISettingsResult = { ok: true; settings: AISettings } | { ok: false; error: string };

export async function loadAISettingsAction(): Promise<AISettingsResult> {
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    return { ok: true, settings: await getAISettings(scope) };
  } catch (error) {
    console.error('[settings:ai] load failed', error);
    return { ok: false, error: 'Could not load your Bubaly settings.' };
  }
}

export async function saveAISettingsAction(patch: AISettingsPatch): Promise<AISettingsResult> {
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const saved = await updateAISettings(scope, patch);
    if (!saved.ok) return { ok: false, error: saved.error };
    // The gate reads these on every tool call; the pages that describe what
    // Bubaly will do should not keep showing the old answer.
    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard/concierge');
    return { ok: true, settings: saved.data };
  } catch (error) {
    console.error('[settings:ai] save failed', error);
    return { ok: false, error: 'Could not save those settings.' };
  }
}
