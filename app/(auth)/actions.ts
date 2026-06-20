'use server';

import { isSuperAdmin } from '@/lib/supabase/auth';

/** Where a just-signed-in user should land: the admin console for super
 *  admins, otherwise the family dashboard. Resolved server-side so the
 *  env/code super-admin allowlist (not just the DB) is honored. */
export async function resolveLandingPathAction(): Promise<string> {
  return (await isSuperAdmin()) ? '/admin' : '/dashboard';
}
