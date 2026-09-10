import 'server-only';
import { z } from 'zod';
import type { UserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from '@/lib/services/types';
import { settleAll } from '@/lib/supabase/settle';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { planLevel } from '@/lib/constants/plans';
import { FEATURE_CATALOG } from '@/lib/constants/feature-catalog';
import { featureAccessByTier, isFeatureTier, resolveFeatureTiers, tiersByHref, type FeatureOverrides } from '@/lib/features/tiers';
import { computeEntitlement } from '@/lib/server/entitlement';

type Access = { ok: true } | {
  ok: false;
  reason: 'context_changed' | 'access_denied' | 'unavailable';
  retryable: boolean;
};
const changed = (): Access => ({ ok: false, reason: 'context_changed', retryable: false });
const denied = (): Access => ({ ok: false, reason: 'access_denied', retryable: false });
function unavailable(stage: string): Access {
  console.error('[document-link/access] authorization unavailable', { stage });
  return { ok: false, reason: 'unavailable', retryable: true };
}

const uuid = z.string().uuid();
const membersSchema = z.array(z.object({
  id: uuid, family_id: uuid, user_id: uuid,
  role: z.enum(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest']),
  is_active: z.literal(true),
}));
const prefsSchema = z.object({ active_family_id: uuid.nullable() }).nullable();
const timestamp = z.string().datetime({ offset: true });
const familySchema = z.object({ id: uuid, trial_ends_at: timestamp.nullable(), closed_at: timestamp.nullable() });
const subscriptionsSchema = z.array(z.object({
  family_id: uuid,
  plan: z.enum(['free', 'family', 'family_annual', 'basic', 'basic_annual', 'plus', 'plus_annual']),
  status: z.enum(['active', 'trialing']),
}));
const inboxHref = '/dashboard/inbox';

/**
 * Fresh authorization through the caller's client, also used after slow remote
 * extraction and on receipt retries. No service-role or fail-open page helper.
 * Manual links have the existing capture membership boundary; selected inbox
 * links additionally require the Inbox's current feature and plan access.
 */
export async function authorizeDocumentLink(
  ctx: UserContext, db: ServiceScope['db'], needsInbox: boolean,
): Promise<Access> {
  const userId = ctx.user.id;
  const familyId = ctx.active.familyId;
  const memberId = ctx.active.member.id;
  if (![userId, familyId, memberId].every((id) => uuid.safeParse(id).success)) return changed();
  try {
    const auth = await db.auth.getUser();
    if (auth.error) {
      if (auth.error.name === 'AuthSessionMissingError' || auth.error.code === 'session_missing') return changed();
      return unavailable('user');
    }
    if (!auth.data.user || auth.data.user.id !== userId) return changed();

    const [membership, preferences] = await settleAll([
      db.from('family_members').select('id, family_id, user_id, role, is_active', { count: 'exact' })
        .eq('user_id', userId).eq('is_active', true),
      db.from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle(),
    ]);
    if (membership.error || preferences.error) return unavailable('membership/preferences');
    const members = membersSchema.safeParse(membership.data);
    const prefs = prefsSchema.safeParse(preferences.data);
    if (!members.success || !prefs.success || membership.count !== members.data.length
      || members.data.some((member) => member.user_id !== userId)) return unavailable('context proof');
    // Match getUserContext's successful missing/stale preference fallback. All
    // current memberships are needed: a newly joined family may now be active.
    const active = members.data.find((member) => member.family_id === prefs.data?.active_family_id) ?? members.data[0];
    if (!active || active.id !== memberId || active.family_id !== familyId || active.role !== ctx.active.role) return changed();
    if (!needsInbox) return { ok: true };

    // Use the newly authenticated email, never an earlier context's email.
    // The page permits both code/env and database super-admin preview access.
    if (isSuperAdminEmail(auth.data.user.email)) return { ok: true };
    const admin = await db.rpc('is_super_admin');
    if (admin.error || typeof admin.data !== 'boolean') return unavailable('super-admin');
    if (admin.data) return { ok: true };

    const [settings, family, subscriptions] = await settleAll([
      db.from('app_settings').select('value').eq('key', 'feature_tiers').maybeSingle(),
      db.from('families').select('id, trial_ends_at, closed_at').eq('id', familyId).maybeSingle(),
      db.from('subscriptions').select('family_id, plan, status', { count: 'exact' })
        .eq('family_id', familyId).in('status', ['active', 'trialing']),
    ]);
    if (settings.error || family.error || subscriptions.error) return unavailable('feature/entitlement');
    const currentFamily = familySchema.safeParse(family.data);
    const currentSubscriptions = subscriptionsSchema.safeParse(subscriptions.data);
    if (!currentFamily.success || currentFamily.data.id !== familyId || !currentSubscriptions.success
      || subscriptions.count !== currentSubscriptions.data.length
      || currentSubscriptions.data.some((subscription) => subscription.family_id !== familyId)) return unavailable('entitlement proof');

    const inboxFeatures = FEATURE_CATALOG.filter((feature) => feature.href === inboxHref);
    if (!inboxFeatures.length) return unavailable('inbox catalog');
    const overrides: FeatureOverrides = {};
    // No row is a valid never-configured catalog. A failed read or malformed
    // relevant override is not evidence that the default grants access.
    if (settings.data !== null) {
      const value = settings.data?.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable('feature settings');
      for (const [key, tier] of Object.entries(value)) {
        if (typeof tier === 'string' && isFeatureTier(tier)) overrides[key] = tier;
        else if (inboxFeatures.some((feature) => feature.key === key)) return unavailable('inbox override');
      }
    }
    const tier = tiersByHref(resolveFeatureTiers(overrides))[inboxHref];
    const entitlement = computeEntitlement({
      paidLevel: currentSubscriptions.data.reduce((level, subscription) => Math.max(level, planLevel(subscription.plan)), 0),
      trialEndsAt: currentFamily.data.trial_ends_at,
      closedAt: currentFamily.data.closed_at,
    });
    if (!tier || entitlement.closed || entitlement.locked
      || featureAccessByTier(tier, entitlement.effectiveLevel) !== 'visible') return denied();
    return { ok: true };
  } catch {
    return unavailable('transport');
  }
}
