import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { LanguageBar } from '@/components/i18n/language-picker';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Safe-area padded for the same reason as the marketing header and
          `.app-topbar`: with viewport-fit=cover and a black-translucent status
          bar, the top of the viewport is underneath the iOS status bar, so an
          unpadded header renders its logo behind the clock. This one does not
          stick, but it is the first thing on the page, so it is exactly what
          lands there. */}
      <header className="flex items-center justify-between px-5 py-5 pt-[calc(1.25rem+var(--safe-top))] sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-8">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="flex flex-col items-center gap-4 px-5 py-6 text-center text-xs text-muted">
        <LanguageBar />
        <Link href="/" className="hover:text-fg">{t('app.backToHome')}</Link>
      </footer>
    </div>
  );
}
