// lib/social/left-connected.ts
//
// The accounts a family that no longer has Social can still disconnect.
import 'server-only';
import type { UserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import type { SocialAccess } from './access';
import { getAccounts, type SocialAccount } from './queries';

export type LeftConnected = {
  accounts: SocialAccount[];
  /** Where to see the plan Social needs; null when Social is switched off for everyone. */
  plansHref: string | null;
};

/**
 * What the social layout shows INSTEAD of the console when the family no
 * longer has Social (a lower plan, the feature switched off, a lapsed trial)
 * but still has accounts connected, and the caller is one who may disconnect
 * them (connect_accounts). Null in every other case, and the layout's
 * requireFeature then decides as before.
 *
 * A family that connected X on Basic and then dropped to Free was sent to
 * billing from every page, the accounts page included, and Bubaly kept its X
 * tokens with no control left that could clear them (household-roles N2-R1).
 * A plan gates creating and changing, not removing (lib/family/actions.ts), so
 * the family keeps this one way to take back what it handed over, and nothing
 * else of Social. A super administrator passes requireFeature, so is not here.
 * An unreadable plan or account list throws, as requireFeature does: it is not
 * an answer either way.
 */
export async function accountsLeftConnected(ctx: UserContext, access: SocialAccess | null): Promise<LeftConnected | null> {
  if (!access?.can('connect_accounts') || isSuperAdminEmail(ctx.user.email)) return null;
  const familyId = ctx.active.familyId;
  const entitlement = await resolveFeatureEntitlement(await createServer(), familyId, '/dashboard/social');
  if (entitlement.allowed) return null;
  const accounts = await getAccounts(familyId);
  if (!accounts.length) return null;
  return {
    accounts,
    plansHref: entitlement.reason === 'off' ? null : `/dashboard/billing?upgrade=1&need=${entitlement.needLevel}`,
  };
}
