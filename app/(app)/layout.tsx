import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { AppLockGate } from '@/components/app/app-lock-gate';
import { isAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';
import { closedFamilyStanding, resolveEntitlement } from '@/lib/server/entitlement';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { TrialPaywallGate } from '@/components/app/trial-paywall-gate';
import { AccountClosedGate } from '@/components/app/account-closed-gate';
import { SessionKeeper } from '@/components/auth/session-keeper';
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';
import { FamilyTimeZoneProvider } from '@/components/i18n/locale-provider';
import { activeFamilyTimeZone } from '@/lib/server/family-time-zone';
import { ConfirmProvider } from '@/components/ui/confirm';
import { AccountsLeftConnected } from '@/components/social/accounts-left-connected';
import { accountsLeftConnectedBehindTheGate, type LeftConnected } from '@/lib/social/left-connected';

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
      {/* Destructive actions ask here rather than in the root layout: every one
          of them is behind this login, and mounting the dialog at the root would
          put its strings (and the Modal's) in the scope every marketing page
          ships. */}
      <ConfirmProvider>
        <AuthenticatedShell>{children}</AuthenticatedShell>
      </ConfirmProvider>
    </ScopedLocaleProvider>
  );
}

async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return <>{children}</>;

  // The family's zone enters the locale context here, above every family
  // surface — the framed routes and the ones with no frame (kids view, kitchen
  // display, settings) alike — so every client clock and day below reads in it
  // (TIME-003). Resolved beside the super-admin check; it never throws.
  const [superAdmin, familyZone] = await Promise.all([
    isSuperAdmin(),
    activeFamilyTimeZone(supabase, user.id),
  ]);
  return (
    <FamilyTimeZoneProvider timeZone={familyZone}>
      <GatedShell supabase={supabase} userId={user.id} superAdmin={superAdmin}>{children}</GatedShell>
    </FamilyTimeZoneProvider>
  );
}

async function GatedShell({
  supabase, userId, superAdmin, children,
}: {
  supabase: Awaited<ReturnType<typeof createServer>>;
  userId: string;
  superAdmin: boolean;
  children: React.ReactNode;
}) {
  const user = { id: userId };
  // Billing gate: a soft-closed account, or a NEW family whose 5-day free trial
  // has ended without subscribing, is locked behind an overlay (super-admins and
  // grandfathered existing free families pass; resolveEntitlement fails open).
  if (!superAdmin) {
    const ent = await resolveEntitlement(supabase, user.id, { isSuperAdmin: false });
    if (ent.closed || ent.locked) {
      // Either gate replaces every route below, the social layout's list of
      // accounts still connected included, so a family whose trial ran out
      // unpaid (every family since 0164 that dropped its plan) or whose account
      // is closed had nothing left that could disconnect X, and Bubaly kept its
      // tokens (household-roles N2-R1). Whoever may disconnect is shown those
      // accounts inside the gate, each with its Disconnect, behind their App Lock
      // (underTheAppLock), and nothing else of Social; everyone else sees the
      // gate as before.
      const left = await accountsBehindTheGate(ent.familyId);
      const appLock = left ? await appLockBehindTheGate(supabase, user.id) : null;
      const disconnect = left && appLock !== 'unreadable' ? <AccountsLeftConnected {...left} /> : null;
      if (ent.closed) {
        // The gate replaces every route below, switcher included, so a member of
        // two households is handed their open ones here, and a non-parent is not
        // offered a reopen the action would refuse (closedFamilyStanding).
        const standing = await closedFamilyStanding(supabase, user.id, ent.familyId);
        return underTheAppLock(disconnect ? appLock : null, user.id,
          <AccountClosedGate canReopen={standing.canReopen} otherFamilies={standing.openFamilies}>{disconnect}</AccountClosedGate>);
      }
      return underTheAppLock(disconnect ? appLock : null, user.id, <TrialPaywallGate trialEndsAt={ent.trialEndsAt}>{disconnect}</TrialPaywallGate>);
    }
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
 * The social accounts the signed-in member may still disconnect, for the gate
 * that replaces every (app) route (lib/social/left-connected.ts). It never
 * stands between the family and its gate: a read that fails shows the gate
 * without them, as it was before, and says so in the log.
 */
async function accountsBehindTheGate(familyId: string | null): Promise<LeftConnected | null> {
  if (!familyId) return null;
  try {
    return await accountsLeftConnectedBehindTheGate(familyId);
  } catch (error) {
    console.error('[app-layout] social accounts behind the gate could not be read', { familyId, error });
    return null;
  }
}

/**
 * The member's App Lock, for the accounts card inside the paywall or the
 * closed-account gate. The card is the one piece of household data either gate
 * shows (each account's name, status and last error), and its Disconnect
 * deletes the family's X tokens, so it waits for the PIN the rest of the app
 * waits for (household-roles N2-R1-APPLOCK). It is the read GatedShell makes
 * below, and it fails the same way, closed: 'unreadable', and the card is left
 * out of the gate.
 */
async function appLockBehindTheGate(
  supabase: Awaited<ReturnType<typeof createServer>>,
  userId: string,
): Promise<AppLockConfig | null | 'unreadable'> {
  const { data: prefs, error } = await supabase
    .from('user_preferences')
    .select('notification_prefs')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[app-layout] app-lock preference read failed; leaving the connected accounts out of the gate', {
      userId, error: error.message,
    });
    return 'unreadable';
  }
  const raw = (prefs?.notification_prefs as Record<string, unknown> | null)?.appLock;
  return isAppLockConfig(raw) ? raw : null;
}

/**
 * The gate, with the accounts card in it, behind the member's App Lock.
 *
 * The WHOLE gate, not the card inside it (household-roles N3-R1-APPLOCK-FOCUS).
 * Both gates and the lock are modal dialogs (useDialogBehavior), and round 3
 * drew the lock inside the gate: React runs a child's effects before its
 * parent's, so the gate's focus trap went on top of the lock's, focus began on
 * "Choose" or "Reopen my account" behind "Enter your PIN", Enter from there
 * started a checkout or a reopen, and Tab walked the gate's controls before it
 * reached the keypad. One dialog at a time: while the session is locked the
 * lock screen is drawn in place of the gate (it covered the gate anyway, so
 * nothing on screen changes), and once the PIN is in, the gate with its
 * accounts. A gate with no card (nothing left connected, or a lock setting that
 * could not be read) has nothing of the household's to hold back: `appLock` is
 * null and the gate is drawn as it was.
 */
function underTheAppLock(appLock: AppLockConfig | null | 'unreadable', userId: string, gate: React.ReactNode): React.ReactNode {
  return appLock && appLock !== 'unreadable' && appLock.enabled
    ? <AppLockGate enabled salt={appLock.salt} hash={appLock.hash} userId={userId}>{gate}</AppLockGate>
    : gate;
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
