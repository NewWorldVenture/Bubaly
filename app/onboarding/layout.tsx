import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { LanguageBar } from '@/components/i18n/language-picker';
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // Onboarding is a long client-driven flow; it keeps the whole catalogue
  // rather than a scope that would have to track every step.
  return (
    <ScopedLocaleProvider namespaces="all">
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
    </ScopedLocaleProvider>
  );
}
