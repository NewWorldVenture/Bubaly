import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { AppProvider } from '@/components/app/app-context';
import { AppShell } from '@/components/app/app-shell';
import { RegisterSW } from '@/components/pwa/register-sw';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const [{ data: members }, superAdmin] = await Promise.all([
    supabase
      .from('family_members')
      .select('*')
      .eq('family_id', ctx.active.familyId)
      .eq('is_active', true)
      .order('created_at'),
    isSuperAdmin(),
  ]);

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
      }}
      initialMembers={members ?? []}
    >
      <AppShell>{children}</AppShell>
      <RegisterSW />
    </AppProvider>
  );
}
