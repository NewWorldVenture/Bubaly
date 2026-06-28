import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView } from '@/lib/constants/dashboards';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { getFeatureTiersByHref } from '@/lib/server/feature-tiers';
import { AppProvider } from '@/components/app/app-context';
import { AppShell } from '@/components/app/app-shell';
import { RegisterSW } from '@/components/pwa/register-sw';
import { NativeBootstrap } from '@/components/native/native-bootstrap';
import { PushRegistrar } from '@/components/native/push-registrar';

/**
 * The authenticated app frame: loads the family context and wraps children in
 * the global AppProvider + AppShell (sidebar, top bar, mobile nav) plus the
 * PWA/native bootstrap. Shared by every signed-in route group that should look
 * like the dashboard (/dashboard, /wallet, /missions, …) so the chrome is
 * identical everywhere instead of only under /dashboard.
 */
export async function AppFrame({ children }: { children: React.ReactNode }) {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const [{ data: members }, { data: prefs }, planLevel, superAdmin, { count: unreadMessages }] = await Promise.all([
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
    resolveFamilyPlanLevel(supabase, ctx.active.familyId),
    isSuperAdmin(),
    // Unread family messages for this user → sidebar Messages badge. Excludes my
    // own messages; `read_by` (user ids) not containing me = unread.
    supabase
      .from('family_messages')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', ctx.active.familyId)
      .is('deleted_at', null)
      .neq('sender_id', ctx.user.id)
      .not('read_by', 'cs', `{${ctx.user.id}}`),
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
        unreadMessages: unreadMessages ?? 0,
      }}
      initialMembers={members ?? []}
    >
      <AppShell>{children}</AppShell>
      <RegisterSW />
      <NativeBootstrap />
      <PushRegistrar />
    </AppProvider>
  );
}
