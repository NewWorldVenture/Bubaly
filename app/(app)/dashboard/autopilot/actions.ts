'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSuperAdmin, requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { isFeatureTier, tierToLevel } from '@/lib/features/tiers';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveSuggestion, type ResolutionResult } from '@/lib/services/autopilot';

const inputSchema = z.object({
  suggestionId: z.string().uuid(), updatedAt: z.string().datetime({ offset: true }),
  expectedFamilyId: z.string().uuid(), expectedUserId: z.string().uuid(),
  action: z.enum(['reminder', 'dismiss']),
}).strict();

export async function resolveAutopilotSuggestionAction(input: z.input<typeof inputSchema>): Promise<ResolutionResult> {
  // Same feature boundary as the page; redirects remain outside the catch.
  const ctx = await requireFeature('/dashboard/autopilot');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid' };
  if (parsed.data.expectedFamilyId !== ctx.active.familyId || parsed.data.expectedUserId !== ctx.user.id) {
    return { ok: false, code: 'contextChanged' };
  }
  try {
    const db = await createServer();
    // Page discovery may fall back to defaults during an override read outage;
    // a write must prove the current setting instead. Keep the page's verified
    // super-admin preview bypass, and its existing plan resolver.
    if (!await isSuperAdmin()) {
      const settings = await db.from('app_settings').select('value').eq('key', 'feature_tiers').maybeSingle();
      if (settings.error) return { ok: false, code: 'unavailable' };
      const value = settings.data?.value;
      if (settings.data && (!value || typeof value !== 'object' || Array.isArray(value))) return { ok: false, code: 'unavailable' };
      const override = value && typeof value === 'object' && !Array.isArray(value) ? value.autopilot : undefined;
      if (override !== undefined && (typeof override !== 'string' || !isFeatureTier(override))) return { ok: false, code: 'unavailable' };
      const tier = override ?? FEATURE_CATALOG_BY_KEY.autopilot.defaultTier;
      if (tier === 'off' || await resolveFamilyPlanLevel(db, ctx.active.familyId) < tierToLevel(tier)) return { ok: false, code: 'accessDenied' };
    }
    // requireUserContext's preference fallback is useful for page reads, but a
    // failed preference read must not choose the destination of this write.
    const preferences = await db.from('user_preferences').select('active_family_id').eq('user_id', ctx.user.id).maybeSingle();
    const membership = await db.from('family_members').select('id, family_id, user_id, role, is_active')
      .eq('id', ctx.active.member.id).eq('family_id', ctx.active.familyId).eq('user_id', ctx.user.id).eq('is_active', true).maybeSingle();
    if (preferences.error || membership.error) return { ok: false, code: 'unavailable' };
    const member = membership.data;
    if (preferences.data?.active_family_id && preferences.data.active_family_id !== ctx.active.familyId) return { ok: false, code: 'contextChanged' };
    if (!member || member.id !== ctx.active.member.id
      || member.family_id !== ctx.active.familyId || member.user_id !== ctx.user.id || !member.is_active || member.role !== ctx.active.role) {
      return { ok: false, code: 'contextChanged' };
    }
    const result = await resolveSuggestion(scopeFromUserContext(ctx, db), parsed.data);
    if (result.ok || result.saved) {
      try {
        revalidatePath('/dashboard/reminders');
        revalidatePath('/dashboard/autopilot');
      } catch (error) {
        // Cache invalidation cannot erase the confirmed persisted outcome.
        console.error('[autopilot-action] refresh failed after saving', error);
      }
    }
    return result;
  } catch (error) {
    console.error('[autopilot-action] resolution failed', error);
    return { ok: false, code: 'unavailable' };
  }
}
