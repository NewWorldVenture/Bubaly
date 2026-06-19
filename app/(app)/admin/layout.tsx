import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';

// Deliberately NOT nested under dashboard/layout.tsx — the site admin console
// oversees every family, so it must never require the viewer to belong to one.
export default async function SiteAdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/login?redirect=/admin');
  const superAdmin = await isSuperAdmin();
  if (!superAdmin) redirect('/dashboard');

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-bg/70 px-4 backdrop-blur-xl sm:px-6">
        <Logo href="/admin" />
        <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand">
          <ShieldCheck className="h-3.5 w-3.5" /> Super Admin
        </span>
        <div className="flex-1" />
        <Link href="/dashboard" className="flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>
        <ThemeToggle />
      </header>
      <main className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
