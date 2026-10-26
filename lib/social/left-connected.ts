// lib/social/left-connected.ts
//
// The accounts a family that no longer has Social can still disconnect.
import 'server-only';
import { isSuperAdmin, type UserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { getSocialAccess, type SocialAccess } from './access';
import { getAccounts, type SocialAccount } from './queries';

export type LeftConnected = {
  accounts: SocialAccount[];
  /** Where to see the plan Social needs; null when no plan on the billing page would bring it back. */
  plansHref: string | null;
};

/**
 * What the social layout shows INSTEAD of the console when the family no
 * longer has Social (a lower plan, the feature switched off) but still has
 * accounts connected, and the caller is one who may disconnect them
 * (connect_accounts). Null in every other case, and the layout's
 * requireFeature then decides as before.
 *
 * A family that connected X on Basic and then dropped to Free was sent to
 * billing from every page, the accounts page included, and Bubaly kept its X
 * tokens with no control left that could clear them (household-roles N2-R1).
 * A plan gates creating and changing, not removing (lib/family/actions.ts), so
 * the family keeps this one way to take back what it handed over, and nothing
 * else of Social. A super administrator passes requireFeature, so is not here:
 * asked the way requireFeature asks (isSuperAdmin: the email list and the
 * database's), and only once the family is known to be without Social. An
 * unreadable plan or account list throws, as requireFeature does: it is not an
 * answer either way.
 *
 * The plans are offered only when the plan is what is missing. Switched off,
 * no plan helps; a locked or closed family never reaches this layout (the (app)
 * shell's gate replaces it, and offers its own plans: see
 * accountsLeftConnectedBehindTheGate).
 */
export async function accountsLeftConnected(ctx: UserContext, access: SocialAccess | null): Promise<LeftConnected | null> {
  if (!access?.can('connect_accounts')) return null;
  const familyId = ctx.active.familyId;
  const entitlement = await resolveFeatureEntitlement(await createServer(), familyId, '/dashboard/social');
  if (entitlement.allowed || await isSuperAdmin()) return null;
  const accounts = await getAccounts(familyId);
  if (!accounts.length) return null;
  return {
    accounts,
    plansHref: entitlement.reason === 'plan' ? `/dashboard/billing?upgrade=1&need=${entitlement.needLevel}` : null,
  };
}

/**
 * The same accounts, for the (app) shell's paywall and closed-account gate
 * (app/(app)/layout.tsx). A family whose trial ran out unpaid (every family
 * created since 0164 that dropped its plan) or whose account is closed has
 * EVERY (app) route replaced by its gate, the social layout and its list above
 * included, so it had no control left that could clear its X tokens
 * (household-roles N2-R1, round 2).
 *
 * The family is known to be without Social there (a locked or closed family is
 * refused every feature) and the caller is not a super administrator (the gates
 * are not drawn for one), so only the caller's social role and the accounts are
 * asked. No plans link: the billing page is behind the same gate, and the
 * paywall offers the plans itself.
 */
export async function accountsLeftConnectedBehindTheGate(familyId: string): Promise<LeftConnected | null> {
  const access = await getSocialAccess(familyId);
  if (!access?.can('connect_accounts')) return null;
  const accounts = await getAccounts(familyId);
  return accounts.length ? { accounts, plansHref: null } : null;
}
