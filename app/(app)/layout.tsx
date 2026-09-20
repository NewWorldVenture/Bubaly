import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { AppLockGate } from '@/components/app/app-lock-gate';
import { isAppLockConfig } from '@/lib/security/app-lock';
import { resolveEntitlement } from '@/lib/server/entitlement';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { TrialPaywallGate } from '@/components/app/trial-paywall-gate';
import { AccountClosedGate } from '@/components/app/account-closed-gate';
import { SessionKeeper } from '@/components/auth/session-keeper';
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';

// Shared layout for ALL authenticated (app) routes — dashboard, wallet, economy,
// admin, family, missions, etc. It does two things: mounts the SessionKeeper so
// a signed-in user stays signed in until they sign out (see that component),
// and applies the opt-in App Lock — when the signed-in user has set a PIN, the
// whole app is gated behind the lock screen (not just the dashboard). It
// intentionally does NOT enforce auth/redirects — each section's own layout
// still does that — so this can never change sign-in behavior.
// The authenticated app keeps the WHOLE catalogue. Its client components reach
// 3,791 keys across 368 namespaces and call t() with a non-literal argument in
// 96 places, so no static subset can be proved complete — and behind a login
// there is no crawler and no first-visit cost to pay for it. The public
// surfaces, which is where the bytes mattered, narrow instead.
export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <ScopedLocaleProvider namespaces="all">
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </ScopedLocaleProvider>
  );
}

async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
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

  // This read decides whether App Lock is applied, and it FAILED OPEN.
  //
  // A refused or failed read left `prefs` null, `appLock` null, and the gate
  // simply not rendered — so a user who set a PIN to protect their family's
  // data on a shared or stolen device had that protection silently removed,
  // across the entire authenticated app, with nothing on screen to say so. It
  // is a security control chosen by the user, and the one direction it must
  // never fail is open.
  //
  // Note the deliberate CONTRAST with the two gates above: `resolveEntitlement`
  // fails open by design, and the comment there says so, because locking a
  // paying family out of their own data over a billing outage is the worse
  // error. App Lock is the opposite case — the thing it withholds is exactly
  // what the user asked to have withheld.
  //
  // It cannot fail closed by rendering the gate: `AppLockGate` verifies the PIN
  // against the `salt` and `hash` from this very read, so a gate without them
  // would lock the user out permanently rather than asking for their PIN. The
  // honest closed answer is to withhold `children` — the protected content —
  // and say why, which is retryable and leaks nothing. Audit C1-S9-44.
  const { data: prefs, error: prefsError } = await supabase
    .from('user_preferences')
    .select('notification_prefs')
    .eq('user_id', user.id)
    .maybeSingle();

  if (prefsError) {
    console.error('[app-layout] app-lock preference read failed; withholding the app rather than unlocking it', {
      userId: user.id, error: prefsError.message,
    });
    return <AppLockUnavailable />;
  }

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

/**
 * Shown when we could not determine whether App Lock is on.
 *
 * Deliberately NOT the lock screen: we have no PIN to check against, so asking
 * for one could only reject. It renders no app content and no navigation into
 * it, which is the whole point — the closed answer has to actually be closed.
 */
async function AppLockUnavailable() {
  const t = await getTranslations();
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-2xl">🔒</div>
      <h1 className="text-xl font-bold">{t('appLock.weCouldNotConfirmYourLockSettings')}</h1>
      <p className="text-sm text-muted">{t('appLock.stayingLockedUntilWeCanCheck')}</p>
    </div>
  );
}
