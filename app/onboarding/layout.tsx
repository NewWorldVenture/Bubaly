import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { getUserContext } from '@/lib/supabase/auth';

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getUserContext();
  if (!ctx) redirect('/login');
  // Already in a family — onboarding is done.
  if (!('needsFamily' in ctx)) redirect('/dashboard');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-start justify-center px-5 py-6">
        <div className="w-full max-w-xl">{children}</div>
      </main>
    </div>
  );
}
