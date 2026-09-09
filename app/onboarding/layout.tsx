import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { LanguageBar } from '@/components/i18n/language-picker';
import { getUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { verifyCalendarWizard } from '@/lib/services/onboarding-calendar/setup';

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getUserContext();
  if (!ctx) redirect('/login');
  // An explicit calendar connection provisions the wizard's family FK before
  // consent. Only its verified, unfinished owner may resume after OAuth.
  if (!('needsFamily' in ctx) && !await verifyCalendarWizard(scopeFromUserContext(ctx, await createServer()), { allowPendingActivation: true })) redirect('/dashboard');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-start justify-center px-5 py-6">
        <div className="w-full max-w-xl">{children}</div>
      </main>
      {/* Someone who cannot read the onboarding copy needs the language control
          before they finish it, not after. */}
      <footer className="flex justify-center px-5 pb-8 pt-2">
        <LanguageBar />
      </footer>
    </div>
  );
}
