import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { FamilyDashboard } from '@/components/dashboard/family-dashboard';
import { PersonalDashboard } from '@/components/dashboard/personal-dashboard';
import { AiHomeDashboard } from '@/components/dashboard/ai-home-dashboard';

export const metadata: Metadata = { title: 'dashboard.home' };

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
  // A preference read that fails is not a dashboard that failed. This lookup
  // only answers "did they pin the family view?", and the honest answer when
  // the row cannot be read is "we don't know" — which is the same as "no", and
  // lands them on the default home. Returning an error page here meant an
  // unreachable user_preferences table (or one flaky read against a database
  // reporting CONNECT_TIMEOUT) cost the user their entire dashboard over a
  // setting most of them never touched.
  if (prefsError) {
    console.warn('[dashboard-home] preference read failed — defaulting to AI home', prefsError.message);
  }

  const savedView: DashboardView | null = isDashboardView(prefs?.default_dashboard) ? (prefs!.default_dashboard as DashboardView) : null;
  if (savedView === 'family') return <FamilyDashboard ctx={ctx} />;

  // Default: AI-first home
  return <AiHomeDashboard ctx={ctx} />;
}
