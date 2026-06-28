import { createServer } from '@/lib/supabase/server';
import { AppLockGate } from '@/components/app/app-lock-gate';
import { isAppLockConfig } from '@/lib/security/app-lock';

// Shared layout for ALL authenticated (app) routes — dashboard, wallet, economy,
// admin, family, missions, etc. Its only job is the opt-in App Lock: when the
// signed-in user has set a PIN, the whole app is gated behind the lock screen
// (not just the dashboard). It intentionally does NOT enforce auth/redirects —
// each section's own layout still does that — so this can never change sign-in
// behavior; it just wraps children with the gate when a lock exists.
export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return <>{children}</>;

  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('notification_prefs')
    .eq('user_id', user.id)
    .maybeSingle();

  const appLockRaw = (prefs?.notification_prefs as Record<string, unknown> | null)?.appLock;
  const appLock = isAppLockConfig(appLockRaw) ? appLockRaw : null;

  if (!appLock?.enabled) return <>{children}</>;

  return (
    <AppLockGate enabled salt={appLock.salt} hash={appLock.hash} userId={user.id}>
      {children}
    </AppLockGate>
  );
}
