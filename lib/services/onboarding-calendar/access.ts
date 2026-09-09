import 'server-only';
import { z } from 'zod';
import { FEATURE_CATALOG_BY_KEY, type FeatureTier } from '@/lib/constants/feature-catalog';
import { planLevel } from '@/lib/constants/plans';
import { isFeatureTier, tierToLevel } from '@/lib/features/tiers';
import { computeEntitlement } from '@/lib/server/entitlement';
import { scopeNow } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';
import { settleAll } from '@/lib/supabase/settle';

const timestamp = z.string().datetime({ offset: true });
const familySchema = z.object({ id: z.string().min(1), trial_ends_at: timestamp.nullable(), closed_at: timestamp.nullable() });
const subscriptionsSchema = z.array(z.object({
  family_id: z.string().min(1),
  plan: z.enum(['free', 'family', 'family_annual', 'basic', 'basic_annual', 'plus', 'plus_annual']),
  status: z.enum(['active', 'trialing']),
}));

/** The private onboarding flow already owns a verified service scope. It needs
 * the actual configuration and family entitlement, without a page-discovery
 * fallback or caller-RLS omissions. Before the family claim, only configuration
 * can be checked; after it exists, its real trial/subscription applies as well.
 * This path deliberately has no administrative preview exemption. */
export async function assertOnboardingCalendarAccess(scope: ServiceScope): Promise<void> {
  const settings = await scope.db.from('app_settings').select('value').eq('key', 'feature_tiers').maybeSingle();
  if (settings.error) throw new Error('Calendar feature configuration unavailable');
  let override: unknown;
  if (settings.data !== null) {
    const value = settings.data?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Calendar feature configuration unavailable');
    override = value['calendar-sync'];
    if (override !== undefined && (typeof override !== 'string' || !isFeatureTier(override))) throw new Error('Calendar feature configuration unavailable');
  }
  const tier = (override as FeatureTier | undefined) ?? FEATURE_CATALOG_BY_KEY['calendar-sync']?.defaultTier;
  if (!tier || tier === 'off') throw new Error('Calendar feature unavailable');
  if (!scope.familyId) return;

  const [family, subscriptions] = await settleAll([
    scope.db.from('families').select('id, trial_ends_at, closed_at').eq('id', scope.familyId).maybeSingle(),
    scope.db.from('subscriptions').select('family_id, plan, status', { count: 'exact' })
      .eq('family_id', scope.familyId).in('status', ['active', 'trialing']),
  ]);
  if (family.error || subscriptions.error) throw new Error('Calendar entitlement unavailable');
  const currentFamily = familySchema.safeParse(family.data);
  const currentSubscriptions = subscriptionsSchema.safeParse(subscriptions.data);
  if (!currentFamily.success || currentFamily.data.id !== scope.familyId || !currentSubscriptions.success
    || subscriptions.count !== currentSubscriptions.data.length
    || currentSubscriptions.data.some((row) => row.family_id !== scope.familyId)) throw new Error('Calendar entitlement unavailable');
  const entitlement = computeEntitlement({
    paidLevel: currentSubscriptions.data.reduce((highest, row) => Math.max(highest, planLevel(row.plan)), 0),
    trialEndsAt: currentFamily.data.trial_ends_at,
    closedAt: currentFamily.data.closed_at,
    now: scopeNow(scope),
  });
  if (entitlement.closed || entitlement.locked || entitlement.effectiveLevel < tierToLevel(tier)) throw new Error('Calendar feature unavailable');
}
