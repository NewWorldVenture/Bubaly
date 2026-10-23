import { redirect } from 'next/navigation';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { settleAll, isCredentialError } from '@/lib/supabase/settle';
import { createServiceClient, describeConfiguredServiceKey, serviceKeyRemedy } from '@/lib/supabase/server';
import { AdminShell } from '@/components/admin/admin-shell';
import { getTranslations } from '@/lib/i18n/server';
import { superAdminAssurance, SUPER_ADMIN_STEP_UP_PATH } from '@/lib/auth/super-admin-assurance';

// Deliberately NOT nested under dashboard/layout.tsx — the site admin console
// oversees every family, so it must never require the viewer to belong to one.
export default async function SiteAdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/login?redirect=/admin');
  const superAdmin = await isSuperAdmin();
  if (!superAdmin) redirect('/dashboard');
  // Same step-up as the family's money pages: a password-only session of an
  // admin with an authenticator enters the code before the console renders.
  if (!(await superAdminAssurance()).ok) redirect(SUPER_ADMIN_STEP_UP_PATH);
  const t = await getTranslations();

  const supabase = createServiceClient();
  // The bell's unread badge counted the unread among the 20 newest
  // notifications it lists, and past them it said 9+ or fewer while there were
  // more; it is a head:true count of every unread notification now, as /admin
  // counts it.
  const reads = await settleAll([
    supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    supabase.from('invites').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('admin_notifications')
      .select('id, kind, title, body, url, is_read, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('admin_notifications').select('id', { count: 'exact', head: true }).eq('is_read', false),
  ]);
  const [profileRes, invitesRes, notificationsRes] = reads;
  const unreadRes = reads[3];

  // A rejected service-role key is not a per-page fault: it fails every read in
  // the console identically. 69 of the 79 admin pages bail to their own generic
  // "could not load X" state, so without this the operator sees 69 different
  // dead ends and no cause. Detecting it once, here, explains all of them —
  // including the pages that render nothing else at all.
  const credentialFault = [profileRes, invitesRes, notificationsRes, unreadRes].some((r) => isCredentialError(r.error))
    ? [describeConfiguredServiceKey(t), serviceKeyRemedy(t)].filter(Boolean).join(' ')
    : null;

  const dataWarnings: string[] = [];
  if (profileRes.error) {
    console.error('[admin-shell] profile read failed:', profileRes.error);
    dataWarnings.push(t('adminCredential.profileUnavailable'));
  }
  if (invitesRes.error) {
    console.error('[admin-shell] pending invite count read failed:', invitesRes.error);
    dataWarnings.push(t('adminCredential.invitesUnavailable'));
  }
  if (notificationsRes.error) {
    console.error('[admin-shell] notification feed read failed:', notificationsRes.error);
    dataWarnings.push(t('adminCredential.notificationsUnavailable'));
  }
  if (unreadRes.error) {
    console.error('[admin-shell] unread notification count read failed:', unreadRes.error);
    // Its own line: the feed itself loaded and is listed in the bell, so
    // "the feed is unavailable" was not what had failed (review
    // R9-UNREAD-COUNT-FAILURE-COPY). When both failed, the feed's line says it.
    if (!notificationsRes.error) dataWarnings.push(t('adminCredential.unreadCountUnavailable'));
  }

  const adminName = profileRes.data?.full_name || profileRes.data?.email || user.email || 'Admin';

  return (
    <AdminShell
      adminName={adminName}
      adminEmail={user.email ?? null}
      // A read that failed reaches the bell as null, not as 0 or an empty feed.
      pendingInviteCount={invitesRes.error ? null : invitesRes.count ?? 0}
      unreadCount={unreadRes.error ? null : unreadRes.count ?? 0}
      notifications={notificationsRes.error ? null : notificationsRes.data ?? []}
      dataWarnings={dataWarnings}
      credentialFault={credentialFault}
    >
      {children}
    </AdminShell>
  );
}
