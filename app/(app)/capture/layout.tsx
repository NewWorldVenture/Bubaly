import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView } from '@/lib/constants/dashboards';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { getFeatureTiersByHref } from '@/lib/server/feature-tiers';
import { AppProvider } from '@/components/app/app-context';
import { AppShell } from '@/components/app/app-shell';
import { RegisterSW } from '@/components/pwa/register-sw';

export default async function CaptureLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const [{ data: members }, { data: prefs }, planLevel, superAdmin, featureTiers] = await Promise.all([
    supabase.from('family_members').select('*').eq('family_id', ctx.active.familyId).eq('is_active', true).order('created_at'),
    supabase.from('user_preferences').select('default_dashboard').eq('user_id', ctx.user.id).maybeSingle(),
    resolveFamilyPlanLevel(supabase, ctx.active.familyId),
    isSuperAdmin(),
    getFeatureTiersByHref(supabase),
  ]);

  const defaultDashboard = isDashboardView(prefs?.default_dashboard) ? prefs.default_dashboard : 'personal';

  return (
    <AppProvider
      value={{
        userId: ctx.user.id,
        userEmail: ctx.user.email,
        familyId: ctx.active.familyId,
        family: ctx.active.family,
        role: ctx.active.role,
        families: ctx.memberships.map((m) => ({ familyId: m.familyId, name: m.family.name })),
        isSuperAdmin: superAdmin,
        defaultDashboard,
        planLevel,
        featureTiers,
      }}
      initialMembers={members ?? []}
    >
      <AppShell>{children}</AppShell>
      <RegisterSW />
    </AppProvider>
  );
}
