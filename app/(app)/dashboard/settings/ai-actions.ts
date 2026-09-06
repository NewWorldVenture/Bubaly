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
import { clearAiMemory, confirmFact, forgetFact, isAiFact, isSensitiveMemory, listMemories } from '@/lib/services/memory';
import type { AISettings } from '@/lib/ai/family-settings';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';

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

// ─── Memory: review and clear (§32) ─────────────────────────────────────────
//
// The Memory toggle promised "let Bubaly remember what it learns … and use it
// next time" with no way to see what that was or take it back. `clearAiMemory`
// and `forgetFact` existed in the service with no caller. These are the
// callers.
//
// Only what BUBALY learned is listed: a fact a person typed into the family's
// own memory is theirs, and does not belong in a panel about what the AI may
// keep. `isAiFact` reads the same `source` column `clearAiMemory` deletes on
// (0265), so what this panel offers to clear and what the clear takes cannot
// drift — under the old notes-prefix scheme an edited note put a fact in
// neither set.

export type AiMemoryItem = {
  id: string;
  kind: 'fact' | 'suggestion';
  label: string;
  value: string;
  category: string;
  /** 0–100, how sure Bubaly was when it offered this. Null when nobody scored it. */
  confidence: number | null;
};

export type AiMemoryResult = { ok: true; items: AiMemoryItem[] } | { ok: false; error: string };

export async function loadAiMemoryAction(): Promise<AiMemoryResult> {
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const memories = await listMemories(scope);
    if (!memories.ok) return { ok: false, error: memories.error };

    const canManage = isManager(ctx.active.role);
    const facts = memories.data.facts
      .filter(isAiFact)
      // The same category fence the context slice uses: medical and account
      // details are not shown to someone who could not read them elsewhere.
      .filter((f) => canManage || !isSensitiveMemory({ category: f.category, key: f.label, content: f.value }))
      // Carried across from the inbox by 0265. It used to be thrown away at
      // the moment of acceptance, so this panel could only ever say null for a
      // fact — which is the one place a person is deciding whether to keep it.
      .map((f): AiMemoryItem => ({ id: f.id, kind: 'fact', label: f.label, value: f.value, category: f.category, confidence: f.confidence }));
    const pending = canManage
      ? memories.data.pending.map((s): AiMemoryItem => ({ id: s.id, kind: 'suggestion', label: s.label, value: s.value, category: s.category, confidence: s.confidence }))
      : [];
    return { ok: true, items: [...pending, ...facts] };
  } catch (error) {
    console.error('[settings:ai] memory load failed', error);
    return { ok: false, error: 'Could not load what Bubaly remembers.' };
  }
}

export async function forgetAiMemoryAction(input: { id: string; kind: 'fact' | 'suggestion' }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await forgetFact(scope, input.id, { kind: input.kind });
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (error) {
    console.error('[settings:ai] forget failed', error);
    return { ok: false, error: 'Could not forget that.' };
  }
}

export async function confirmAiMemoryAction(input: { id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await confirmFact(scope, input.id);
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (error) {
    console.error('[settings:ai] confirm failed', error);
    return { ok: false, error: 'Could not confirm that.' };
  }
}

export async function clearAiMemoryAction(): Promise<{ ok: true; facts: number; suggestions: number } | { ok: false; error: string }> {
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await clearAiMemory(scope);
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    return { ok: true, ...res.data };
  } catch (error) {
    console.error('[settings:ai] clear failed', error);
    return { ok: false, error: "Could not clear Bubaly's memory." };
  }
}
