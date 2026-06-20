import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView, type DashboardView } from '@/lib/constants/dashboards';
import { FamilyDashboard } from '@/components/dashboard/family-dashboard';
import { PersonalDashboard } from '@/components/dashboard/personal-dashboard';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await requireUserContext();
  const { view: viewParam } = await searchParams;

  // An explicit ?view= wins; otherwise fall back to the saved preference.
  let view: DashboardView = 'personal';
  if (isDashboardView(viewParam)) {
    view = viewParam;
  } else {
    const supabase = await createServer();
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('default_dashboard')
      .eq('user_id', ctx.user.id)
      .maybeSingle();
    if (isDashboardView(prefs?.default_dashboard)) view = prefs.default_dashboard;
  }

  return view === 'family' ? <FamilyDashboard ctx={ctx} /> : <PersonalDashboard ctx={ctx} />;
}
