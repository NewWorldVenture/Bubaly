import { unstable_noStore as noStore } from 'next/cache';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
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
  // Always render the shell fresh — the account tier / nav gating must reflect the
  // live subscription, never a cached Data Cache result (which surfaced as a stale
  // "Free Tier" after an upgrade).
  noStore();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // This frame wraps EVERY authenticated page, so a rejection here is not one
  // broken page — it is the whole signed-in app returning an error. Neither of
  // these two is a { data, error } read, so they are resolved beside the batch
  // with fallbacks chosen for what they gate:
  //
  //   planLevel  → 0, the free tier. A failed read shows FEWER features, never
  //                more, so a flaky database cannot unlock paid surfaces.
  //   superAdmin → false. Fails CLOSED. An unreachable check must never be
  //                mistaken for an affirmative one.
  const [planLevel, superAdmin] = await Promise.all([
    resolveFamilyPlanLevel(supabase, ctx.active.familyId).catch((cause) => {
      console.warn('[app-frame] plan level read failed — assuming free tier', cause);
      return 0 as Awaited<ReturnType<typeof resolveFamilyPlanLevel>>;
    }),
    isSuperAdmin().catch((cause) => {
      console.warn('[app-frame] super-admin check failed — denying', cause);
      return false;
    }),
  ]);

  const [{ data: members }, { data: prefs }, { count: unreadMessages }] = await settleAll([
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
      membershipId={ctx.active.member.id}
      membershipUpdatedAt={ctx.active.member.updated_at}
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
