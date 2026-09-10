import { createServer } from '@/lib/supabase/server';
import { AppLockGate } from '@/components/app/app-lock-gate';
import { isAppLockConfig } from '@/lib/security/app-lock';
import { resolveEntitlement } from '@/lib/server/entitlement';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { TrialPaywallGate } from '@/components/app/trial-paywall-gate';
import { AccountClosedGate } from '@/components/app/account-closed-gate';
import { SessionKeeper } from '@/components/auth/session-keeper';

// Shared layout for ALL authenticated (app) routes — dashboard, wallet, economy,
// admin, family, missions, etc. It does two things: mounts the SessionKeeper so
// a signed-in user stays signed in until they sign out (see that component),
// and applies the opt-in App Lock — when the signed-in user has set a PIN, the
// whole app is gated behind the lock screen (not just the dashboard). It
// intentionally does NOT enforce auth/redirects — each section's own layout
// still does that — so this can never change sign-in behavior.
export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return <>{children}</>;

  // Billing gate: a soft-closed account, or a NEW family whose 5-day free trial
  // has ended without subscribing, is locked behind an overlay (super-admins and
  // grandfathered existing free families pass; resolveEntitlement fails open).
  const superAdmin = await isSuperAdmin();
  if (!superAdmin) {
    const ent = await resolveEntitlement(supabase, user.id, { isSuperAdmin: false });
    if (ent.closed) return <AccountClosedGate />;
    if (ent.locked) return <TrialPaywallGate trialEndsAt={ent.trialEndsAt} />;
  }

  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('notification_prefs')
    .eq('user_id', user.id)
    .maybeSingle();

  const appLockRaw = (prefs?.notification_prefs as Record<string, unknown> | null)?.appLock;
  const appLock = isAppLockConfig(appLockRaw) ? appLockRaw : null;

  // The keeper sits outside the App Lock gate on purpose: the session must keep
  // refreshing while the lock screen is up, so unlocking with the PIN lands on a
  // live session rather than a login page.
  return (
    <>
      <SessionKeeper userId={user.id} />
      {appLock?.enabled
        ? (
          <AppLockGate enabled salt={appLock.salt} hash={appLock.hash} userId={user.id}>
            {children}
          </AppLockGate>
        )
        : children}
    </>
  );
}
