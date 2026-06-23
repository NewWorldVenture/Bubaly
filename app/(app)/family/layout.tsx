import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView } from '@/lib/constants/dashboards';
import { planLevel as planLevelOf } from '@/lib/constants/plans';
import { getFeatureOverrides } from '@/lib/features/server';
import { AppProvider } from '@/components/app/app-context';
import { AppShell } from '@/components/app/app-shell';
import { RegisterSW } from '@/components/pwa/register-sw';

// Family administration routes share the same authenticated shell as the
// dashboard so navigation, family switching and the notification bell all work.
export default async function FamilyLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const [{ data: members }, { data: prefs }, { data: sub }, superAdmin] = await Promise.all([
    supabase
      .from('family_members')
      .select('*')
      .eq('family_id', ctx.active.familyId)
      .eq('is_active', true)
      .order('created_at'),
    supabase
      .from('user_preferences')
      .select('default_dashboard')
      .eq('user_id', ctx.user.id)
      .maybeSingle(),
    supabase
      .from('subscriptions')
      .select('plan, status')
      .eq('family_id', ctx.active.familyId)
      .in('status', ['active', 'trialing'])
      .maybeSingle(),
    isSuperAdmin(),
  ]);

  const defaultDashboard = isDashboardView(prefs?.default_dashboard)
    ? prefs.default_dashboard
    : 'personal';
  const planLevel = planLevelOf(sub?.plan ?? null);
  const featureOverrides = await getFeatureOverrides(supabase);

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
        featureOverrides,
      }}
      initialMembers={members ?? []}
    >
      <AppShell>{children}</AppShell>
      <RegisterSW />
    </AppProvider>
  );
}
