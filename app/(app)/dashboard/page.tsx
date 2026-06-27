import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { FamilyDashboard } from '@/components/dashboard/family-dashboard';
import { PersonalDashboard } from '@/components/dashboard/personal-dashboard';
import { AiHomeDashboard } from '@/components/dashboard/ai-home-dashboard';

export const metadata: Metadata = { title: 'Home' };

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
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('default_dashboard')
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  const savedView: DashboardView | null = isDashboardView(prefs?.default_dashboard) ? (prefs!.default_dashboard as DashboardView) : null;
  if (savedView === 'family') return <FamilyDashboard ctx={ctx} />;

  // Default: AI-first home
  return <AiHomeDashboard ctx={ctx} />;
}
