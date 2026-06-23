import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import {
  resolveSlot, resolveVariant,
  type VisitorContext, type PersonalizationRule, type PersonalizationVariant,
} from '@/lib/marketing/personalization';

/**
 * Read active rules for a slot and resolve the best variant for this visitor.
 * Surfaces (home hero, pricing CTA, landing slots) call this server-side, render
 * the variant, and record an exposure via the A/B /api/ab/track plumbing.
 * Marketing tables have no client policies, so reads go through the service role.
 */
async function loadSlotRules(slot: string): Promise<PersonalizationRule[]> {
  const { data } = await createServiceClient()
    .from('marketing_personalization_rules')
    .select('id, slot, match, variant, priority, status, created_at, deleted_at')
    .eq('slot', slot)
    .eq('status', 'active')
    .is('deleted_at', null);
  return (data ?? []) as unknown as PersonalizationRule[];
}

export async function resolvePersonalization(slot: string, ctx: VisitorContext): Promise<PersonalizationVariant | null> {
  return resolveVariant(await loadSlotRules(slot), slot, ctx);
}

export async function resolvePersonalizationRule(slot: string, ctx: VisitorContext): Promise<PersonalizationRule | null> {
  return resolveSlot(await loadSlotRules(slot), slot, ctx);
}
