'use server';

// Settings → Bubaly AI. The server half: read the family's settings for the
// panel, and save a manager's changes.
//
// Both go through `lib/services/ai-settings`, which is where the manager check
// and the validation live — an action that trusted its input would be the one
// place a child could widen what the AI may do, and the service is also what
// the tool gate reads, so page and gate can never disagree about the rules.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { getAISettings, updateAISettings, type AISettingsPatch } from '@/lib/services/ai-settings';
import {
  clearAiMemory, confirmFact, forgetFact, forgetRoutine, isAiFact, isSensitiveMemory, listMemories, resetMemberTraits,
} from '@/lib/services/memory';
import type { AISettings } from '@/lib/ai/family-settings';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';

export type AISettingsResult = { ok: true; settings: AISettings } | { ok: false; error: string };

export async function loadAISettingsAction(): Promise<AISettingsResult> {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    return { ok: true, settings: await getAISettings(scope) };
  } catch (error) {
    console.error('[settings:ai] load failed', error);
    return { ok: false, error: t('aiActions.couldNotLoadYourBubaly') };
  }
}

export async function saveAISettingsAction(patch: AISettingsPatch): Promise<AISettingsResult> {
  const t = await getTranslations();
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
    return { ok: false, error: t('aiActions.couldNotSaveThoseSettings') };
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

/**
 * A routine Bubaly holds for the household, as the panel shows it. `detected`
 * is read from the row's own `source` column — the panel may only say "Bubaly
 * noticed this" when the row says so.
 */
export type AiRoutineItem = {
  id: string;
  name: string;
  detected: boolean;
  isActive: boolean;
  weekdayMask: number;
};

/** What the autopilot worked out about one member, as the panel shows it. */
export type AiTraitItem = {
  memberId: string;
  memberName: string | null;
  reliabilityScore: number | null;
  choreCompletionRate: number | null;
  sampleSize: number | null;
};

export type AiMemoryResult =
  | { ok: true; items: AiMemoryItem[]; routines: AiRoutineItem[]; traits: AiTraitItem[] }
  | { ok: false; error: string };

/** `routine_templates.source` values that mean Bubaly detected the pattern rather than a person building it. */
const DETECTED_ROUTINE_SOURCES = new Set(['ai', 'ai_detected', 'autopilot', 'detected']);

export async function loadAiMemoryAction(): Promise<AiMemoryResult> {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const memories = await listMemories(scope, { includeProfile: true });
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
    const routines: AiRoutineItem[] = (memories.data.routines ?? []).map((r) => ({
      id: r.id, name: r.name, detected: DETECTED_ROUTINE_SOURCES.has(r.source), isActive: r.isActive, weekdayMask: r.weekdayMask,
    }));
    const traits: AiTraitItem[] = (memories.data.traits ?? []).map((t2) => ({
      memberId: t2.memberId, memberName: t2.memberName,
      reliabilityScore: t2.reliabilityScore, choreCompletionRate: t2.choreCompletionRate, sampleSize: t2.sampleSize,
    }));
    return { ok: true, items: [...pending, ...facts], routines, traits };
  } catch (error) {
    console.error('[settings:ai] memory load failed', error);
    return { ok: false, error: t('aiActions.couldNotLoadWhatBubaly') };
  }
}

/**
 * Take back one routine. A thin skin over the service, which owns the manager
 * check and the family scoping — the routines panel on the calendar deletes
 * the same row straight from the browser, and this path adds the role rule
 * that one never had.
 */
export async function forgetRoutineAction(input: { id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await forgetRoutine(scope, input.id);
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard/calendar');
    return { ok: true };
  } catch (error) {
    console.error('[settings:ai] routine forget failed', error);
    return { ok: false, error: t('aiActions.couldNotForgetThatRoutine') };
  }
}

/** Reset what the autopilot learned about ONE member. Manager-only, in the service. */
export async function resetMemberTraitsAction(input: { memberId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await resetMemberTraits(scope, input.memberId);
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (error) {
    console.error('[settings:ai] trait reset failed', error);
    return { ok: false, error: t('aiActions.couldNotResetWhatBubaly') };
  }
}

export async function forgetAiMemoryAction(input: { id: string; kind: 'fact' | 'suggestion' }): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await forgetFact(scope, input.id, { kind: input.kind });
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (error) {
    console.error('[settings:ai] forget failed', error);
    return { ok: false, error: t('aiActions.couldNotForgetThat') };
  }
}

export async function confirmAiMemoryAction(input: { id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const scope = scopeFromUserContext(ctx, await createServer());
    const res = await confirmFact(scope, input.id);
    if (!res.ok) return { ok: false, error: res.error };
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (error) {
    console.error('[settings:ai] confirm failed', error);
    return { ok: false, error: t('aiActions.couldNotConfirmThat') };
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
