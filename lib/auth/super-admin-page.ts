import 'server-only';
import { redirect } from 'next/navigation';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { superAdminAssurance, SUPER_ADMIN_STEP_UP_PATH } from '@/lib/auth/super-admin-assurance';

/**
 * The /admin layout's gate, asked by a PAGE before its own first service-role
 * read.
 *
 * The layout is not a gate for its pages. On a client-side (RSC) navigation
 * Next renders from the first segment that differs from the router state tree
 * the request names, so a request that claims to be coming from another
 * /admin page is rendered from the page segment down, and app/(app)/admin/
 * layout.tsx — where the super-admin and step-up checks live — never runs.
 * middleware.ts only asks that a session exists. Any signed-in member could
 * read a page's service-role data that way, so a page holding such data asks
 * the same three questions itself, in the layout's order and with its answers:
 * no session goes to sign in, no super-admin goes back to the family
 * dashboard, and a session that owes its authenticator code goes to step-up.
 *
 * `redirect` throws, so nothing after this call runs for anyone it turns away.
 */
export async function requireSuperAdminPage(): Promise<NonNullable<Awaited<ReturnType<typeof getUser>>>> {
  const user = await getUser();
  if (!user) redirect('/login?redirect=/admin');
  if (!(await isSuperAdmin())) redirect('/dashboard');
  if (!(await superAdminAssurance()).ok) redirect(SUPER_ADMIN_STEP_UP_PATH);
  return user;
}
