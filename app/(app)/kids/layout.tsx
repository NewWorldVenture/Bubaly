import Link from 'next/link';
import { LogoMark } from '@/components/brand/logo';
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';

// Deliberately simple, child-safe chrome: big, friendly, and only the kid's own
// world — no finance, health, admin or cross-family data. Full guard via
// requireUserContext (redirects to /login or /onboarding as needed).
export default async function KidsLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  await requireUserContext();
  return (
    <div className="min-h-dvh bg-bg">
      {/* Safe-area padded — see the marketing header and `.app-topbar`: the
          top of the viewport sits under the iOS status bar on an installed
          PWA, and this header is the first thing on the page. */}
      <header className="flex items-center justify-between px-4 py-4 pt-[calc(1rem+var(--safe-top))] sm:px-6">
        <div className="flex items-center gap-2"><LogoMark className="h-8 w-14" /><span className="text-lg font-black">{t('kids.myBubaly')}</span></div>
        <Link href="/dashboard" className="rounded-full bg-surface px-4 py-2 text-sm font-semibold">{t('kids.grownUpView')}</Link>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">{children}</main>
    </div>
  );
}
