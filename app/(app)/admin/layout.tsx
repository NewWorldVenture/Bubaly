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
  const [profileRes, invitesRes, notificationsRes] = await Promise.all([
    supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    supabase.from('invites').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('admin_notifications')
      .select('id, kind, title, body, url, is_read, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const dataWarnings: string[] = [];
  if (profileRes.error) {
    console.error('[admin-shell] profile read failed:', profileRes.error);
    dataWarnings.push('Your admin profile could not be loaded; your account email is shown instead.');
  }
  if (invitesRes.error) {
    console.error('[admin-shell] pending invite count read failed:', invitesRes.error);
    dataWarnings.push('The pending invitation count is unavailable.');
  }
  if (notificationsRes.error) {
    console.error('[admin-shell] notification feed read failed:', notificationsRes.error);
    dataWarnings.push('The admin notification feed is unavailable.');
  }

  const adminName = profileRes.data?.full_name || profileRes.data?.email || user.email || 'Admin';

  return (
    <AdminShell
      adminName={adminName}
      adminEmail={user.email ?? null}
      pendingInviteCount={invitesRes.count ?? 0}
      notifications={notificationsRes.data ?? []}
      dataWarnings={dataWarnings}
    >
      {children}
    </AdminShell>
  );
}
