import { redirect } from 'next/navigation';
import { createServer } from '@/lib/supabase/server';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { readAppLockRecord } from '@/lib/security/app-lock-store';
import { AppLockBoundary } from '@/components/app/app-lock-boundary';
import { SessionKeeper } from '@/components/auth/session-keeper';
import { SignOutForm } from '@/components/auth/sign-out-form';
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';
import { getTranslations } from '@/lib/i18n/server';

export default async function AppLockPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const supabase = await createServer();
  const { data, error } = await supabase.auth.getUser();
  if (!error && !data.user) redirect('/login');
  const t = await getTranslations();
  const unavailable = <ScopedLocaleProvider namespaces="all"><div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 py-10 text-center">
    <h1 className="text-xl font-bold">{t('appLock.weCouldNotConfirmYourLockSettings')}</h1>
    <p className="text-sm text-muted">{t('appLock.stayingLockedUntilWeCanCheck')}</p>
      <SignOutForm><button type="submit" className="rounded-lg border border-border px-4 py-2 text-sm font-medium focus-ring">{t('signOutButton.signOut')}</button></SignOutForm>
  </div></ScopedLocaleProvider>;
  if (error || !data.user) return unavailable;
  const user = data.user;
  const next = (await searchParams).next;
  const requested = safeInternalRedirect(typeof next === 'string' ? next : undefined, '/dashboard');
  const returnTo = requested.split(/[?#]/)[0] === '/app-lock' ? '/dashboard' : requested;
  const loaded = await readAppLockRecord(user.id);
  if (!loaded.ok) return unavailable;
  const record = loaded.record;
  if (!record?.config?.enabled) redirect(returnTo);
  // Always keep this dedicated screen closed until its explicit PIN action.
  // A failed Lock now may leave a still-valid cookie and a pending client
  // privacy intent; redirecting that cookie would strand its retry elsewhere.
  return <ScopedLocaleProvider namespaces="all">
    <SessionKeeper userId={user.id} />
    <AppLockBoundary userId={user.id} enabled locked returnTo={returnTo} />
  </ScopedLocaleProvider>;
}
