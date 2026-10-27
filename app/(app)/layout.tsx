import { cookies } from 'next/headers';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { AppLockBoundary } from '@/components/app/app-lock-boundary';
import { APP_UNLOCK_COOKIE, isAppUnlocked, readAppLockSessionId } from '@/lib/security/app-lock-server';
import { readAppLockRecord } from '@/lib/security/app-lock-store';
import { closedFamilyStanding, resolveEntitlement } from '@/lib/server/entitlement';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { TrialPaywallGate } from '@/components/app/trial-paywall-gate';
import { AccountClosedGate } from '@/components/app/account-closed-gate';
import { SessionKeeper } from '@/components/auth/session-keeper';
import { SignOutForm } from '@/components/auth/sign-out-form';
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';
import { FamilyTimeZoneProvider } from '@/components/i18n/locale-provider';
import { activeFamilyTimeZone } from '@/lib/server/family-time-zone';
import { ConfirmProvider } from '@/components/ui/confirm';
import { ToastProvider } from '@/components/ui/toast';
import { AccountsLeftConnected } from '@/components/social/accounts-left-connected';
import { accountsLeftConnectedBehindTheGate, type LeftConnected } from '@/lib/social/left-connected';

// Shared layout for ALL authenticated (app) routes — dashboard, wallet, economy,
// admin, family, missions, etc. It does two things: mounts the SessionKeeper so
// a signed-in user stays signed in until they sign out (see that component),
// and applies the opt-in App Lock — when the signed-in user has set a PIN and
// this browser has not unlocked it, the whole app is replaced by the lock
// screen (not just the dashboard), on the server. It intentionally does NOT
// enforce auth/redirects — each section's own layout still does that — so
// this can never change sign-in behavior.
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
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError && authError.name !== 'AuthSessionMissingError') return <AppLockUnavailable />;
  const user = auth.user;
  if (!user) return <>{children}</>;

  // Read the private credential before billing, household names, timezone or
  // any protected child is handed to the client. An unreadable store cannot
  // be interpreted as an absent lock (including during the schema rollout).
  const current = await readAppLockRecord(user.id);
  if (!current.ok) return <AppLockUnavailable />;
  const record = current.record;
  const enabled = record?.config?.enabled === true;
  const sessionId = enabled ? await readAppLockSessionId(supabase, user.id) : null;
  const locked = enabled && !isAppUnlocked(user.id, record!, sessionId, (await cookies()).get(APP_UNLOCK_COOKIE)?.value);

  // Only an unlocked render includes children. The client boundary retires
  // already-rendered content on local/cross-tab lock and history restoration.
  // Supabase sessions/RLS continue to authorize direct API and native traffic.
  return (
    <>
      <SessionKeeper userId={user.id} />
      <AppLockBoundary userId={user.id} enabled={enabled} locked={locked}>
        {locked ? null : <UnlockedShell supabase={supabase} userId={user.id}>{children}</UnlockedShell>}
      </AppLockBoundary>
    </>
  );
}

async function UnlockedShell({
  supabase, userId, children,
}: {
  supabase: Awaited<ReturnType<typeof createServer>>;
  userId: string;
  children: React.ReactNode;
}) {
  const [superAdmin, familyZone] = await Promise.all([
    isSuperAdmin(), activeFamilyTimeZone(supabase, userId),
  ]);
  let content = children;
  if (!superAdmin) {
    const ent = await resolveEntitlement(supabase, userId, { isSuperAdmin: false });
    if (ent.closed || ent.locked) {
      // Either gate replaces every route below, the social layout's list of
      // accounts still connected included, so a family whose trial ran out
      // unpaid (every family since 0164 that dropped its plan) or whose account
      // is closed had nothing left that could disconnect X, and Bubaly kept its
      // tokens (household-roles N2-R1). Whoever may disconnect is shown those
      // accounts inside the gate, each with its Disconnect, and nothing else of
      // Social; everyone else sees the gate as before.
      //
      // The card is the one piece of household data either gate shows, and its
      // Disconnect deletes the family's X tokens, so it waits for the member's
      // App Lock PIN like the rest of the app (household-roles N2-R1-APPLOCK).
      // That holds here by construction: this shell, the gate and its card
      // included, renders only for an unlocked session, and a locked one is
      // sent the lock screen alone, the one dialog on the page
      // (N3-R1-APPLOCK-FOCUS); a lock setting that cannot be read withholds
      // the whole app, this gate too (AuthenticatedShell, above).
      const left = await accountsBehindTheGate(ent.familyId);
      const disconnect = left ? <AccountsLeftConnected {...left} /> : null;
      if (ent.closed) {
        // The gate replaces every route below, switcher included, so a member of
        // two households is handed their open ones here, and a non-parent is not
        // offered a reopen the action would refuse (closedFamilyStanding).
        const standing = await closedFamilyStanding(supabase, userId, ent.familyId);
        content = <AccountClosedGate canReopen={standing.canReopen} otherFamilies={standing.openFamilies}>{disconnect}</AccountClosedGate>;
      } else {
        content = <TrialPaywallGate trialEndsAt={ent.trialEndsAt}>{disconnect}</TrialPaywallGate>;
      }
    }
  }
  return <FamilyTimeZoneProvider timeZone={familyZone}><ToastProvider><ConfirmProvider>{content}</ConfirmProvider></ToastProvider></FamilyTimeZoneProvider>;
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
      <SignOutForm><button type="submit" className="rounded-lg border border-border px-4 py-2 text-sm font-medium focus-ring">{t('signOutButton.signOut')}</button></SignOutForm>
    </div>
  );
}
