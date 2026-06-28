import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isDashboardView } from '@/lib/constants/dashboards';
import { planLevel as planLevelOf } from '@/lib/constants/plans';
import { getFeatureTiersByHref } from '@/lib/server/feature-tiers';
import { AppProvider } from '@/components/app/app-context';
import { AppShell } from '@/components/app/app-shell';
import { AppLockGate } from '@/components/app/app-lock-gate';
import { isAppLockConfig } from '@/lib/security/app-lock';
import { RegisterSW } from '@/components/pwa/register-sw';
import { NativeBootstrap } from '@/components/native/native-bootstrap';
import { PushRegistrar } from '@/components/native/push-registrar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
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
      .select('default_dashboard, notification_prefs')
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
  const featureTiers = await getFeatureTiersByHref(supabase);

  // Opt-in App Lock config (per-user, stored in notification_prefs).
  const appLockRaw = (prefs?.notification_prefs as Record<string, unknown> | null)?.appLock;
  const appLock = isAppLockConfig(appLockRaw) ? appLockRaw : null;

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
      <AppLockGate
        enabled={!!appLock?.enabled}
        salt={appLock?.salt ?? ''}
        hash={appLock?.hash ?? ''}
        userId={ctx.user.id}
      >
        <AppShell>{children}</AppShell>
      </AppLockGate>
      <RegisterSW />
      <NativeBootstrap />
      <PushRegistrar />
    </AppProvider>
  );
}
