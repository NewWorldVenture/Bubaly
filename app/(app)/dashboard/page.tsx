import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import Link from 'next/link';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { FamilyDashboard } from '@/components/dashboard/family-dashboard';
import { PersonalDashboard } from '@/components/dashboard/personal-dashboard';
import { AiHomeDashboard } from '@/components/dashboard/ai-home-dashboard';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'dashboard.home' };

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">Home</h1>
      <ErrorState message="Could not load your dashboard preference from Supabase. Refresh and try again." />
      <Link href="/dashboard" className="text-sm font-medium text-brand-text underline">{t('dashboard.refreshHome')}</Link>
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await requireUserContext();
  const { view: viewParam } = await searchParams;

  // ?view=personal or ?view=family shows the legacy dashboards.
  // Default (no view param) → new AI-first home.
  if (isDashboardView(viewParam)) {
    return viewParam === 'family' ? <FamilyDashboard ctx={ctx} /> : <PersonalDashboard ctx={ctx} />;
  }

  // Check saved preference — if it's explicitly set to family, show family dashboard.
  const supabase = await createServer();
  const { data: prefs, error: prefsError } = await supabase
    .from('user_preferences')
    .select('default_dashboard')
    .eq('user_id', ctx.user.id)
    .maybeSingle();
  if (prefsError) {
    console.error('[dashboard-home] dashboard preference read failed', prefsError);
    return <ReadFailure />;
  }

  const savedView: DashboardView | null = isDashboardView(prefs?.default_dashboard) ? (prefs!.default_dashboard as DashboardView) : null;
  if (savedView === 'family') return <FamilyDashboard ctx={ctx} />;

  // Default: AI-first home
  return <AiHomeDashboard ctx={ctx} />;
}
