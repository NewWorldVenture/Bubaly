import 'server-only';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { superAdminAssurance } from '@/lib/auth/super-admin-assurance';

/**
 * The super-admin gate as an ANSWER, never a throw (SRV-001 l6).
 *
 * Its own module, beside lib/supabase/auth rather than in it, so a test that
 * stands in for getUser and isSuperAdmin exercises this gate unchanged.
 *
 * getUser() and isSuperAdmin() raise on a RETRYABLE auth failure, correctly:
 * "we could not tell" is not "signed out". But an admin server action that
 * awaited them before its own try rejected instead of returning its result, so
 * the Stripe and service-description buttons spun with no message until a
 * reload, and the <form action> forms fell to the error boundary and threw
 * away what the operator had typed. `unavailable` lets each action say the
 * account could not be checked, and nothing is written.
 *
 * `step_up` is a super-admin whose session has not proved the authenticator it
 * has enrolled (or whose assurance level could not be read). It is refused like
 * `forbidden`; see lib/auth/super-admin-assurance.ts.
 */
export type SuperAdminGate =
  | { status: 'allowed'; user: NonNullable<Awaited<ReturnType<typeof getUser>>> }
  | { status: 'forbidden' }
  | { status: 'step_up' }
  | { status: 'unavailable' };

export async function superAdminGate(): Promise<SuperAdminGate> {
  try {
    const user = await getUser();
    if (!user) return { status: 'forbidden' };
    if (!(await isSuperAdmin())) return { status: 'forbidden' };
    if (!(await superAdminAssurance()).ok) return { status: 'step_up' };
    return { status: 'allowed', user };
  } catch (error) {
    console.error('[auth] super-admin check could not complete', error);
    return { status: 'unavailable' };
  }
}
