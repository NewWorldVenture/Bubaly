import { redirect } from 'next/navigation';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { AdminShell } from '@/components/admin/admin-shell';

// Deliberately NOT nested under dashboard/layout.tsx — the site admin console
// oversees every family, so it must never require the viewer to belong to one.
export default async function SiteAdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/login?redirect=/admin');
  const superAdmin = await isSuperAdmin();
  if (!superAdmin) redirect('/dashboard');

  const supabase = createServiceClient();
  const [{ data: profile }, { count: pendingInviteCount }] = await Promise.all([
    supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    supabase.from('invites').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  const adminName = profile?.full_name || profile?.email || user.email || 'Admin';

  return (
    <AdminShell adminName={adminName} adminEmail={user.email ?? null} pendingInviteCount={pendingInviteCount ?? 0}>
      {children}
    </AdminShell>
  );
}
