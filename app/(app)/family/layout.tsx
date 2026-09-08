import { unstable_noStore as noStore } from 'next/cache';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView } from '@/lib/constants/dashboards';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { getFeatureTiersByHref } from '@/lib/server/feature-tiers';
import { AppProvider } from '@/components/app/app-context';
import { AppShell } from '@/components/app/app-shell';
import { RegisterSW } from '@/components/pwa/register-sw';

// Family administration routes share the same authenticated shell as the
// dashboard so navigation, family switching and the notification bell all work.
export default async function FamilyLayout({ children }: { children: React.ReactNode }) {
  noStore();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Same shape as AppFrame: two access checks that are not { data, error }
  // reads, resolved beside the batch with fallbacks that fail in the safe
  // direction — free tier (fewer features, never more) and super-admin denied.
  const [planLevel, superAdmin] = await Promise.all([
    resolveFamilyPlanLevel(supabase, ctx.active.familyId).catch((cause) => {
      console.warn('[layout] plan level read failed — assuming free tier', cause);
      return 0 as Awaited<ReturnType<typeof resolveFamilyPlanLevel>>;
    }),
    isSuperAdmin().catch((cause) => {
      console.warn('[layout] super-admin check failed — denying', cause);
      return false;
    }),
  ]);

  const [{ data: members }, { data: prefs }] = await settleAll([
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
  ]);

  const defaultDashboard = isDashboardView(prefs?.default_dashboard)
    ? prefs.default_dashboard
    : 'personal';
  const featureTiers = await getFeatureTiersByHref(supabase);

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
