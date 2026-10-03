// Is the person behind this scope a super-administrator? (F19)
//
// `assertAIAccess` and `assertAIAllowance` never refuse a super-administrator
// on the monthly allowance: they read the email off the signed-in context. The
// atomic admission (`admit_ai_request`, 0477) runs further down, behind
// `withAiRequest` and the concierge intake, where only a `ServiceScope` is in
// hand — no email. So a super-admin acting in a Free family at 10 of 10 passed
// the gate and was then refused by the admission, which the gate's own rule
// says must not happen.
//
// This answers the question from the scope's user id, through the ledger
// client, with the same allowlist the gate uses (`isSuperAdminEmail`). It is
// asked ONLY after an admission refused, so the ordinary path makes no extra
// call. A system scope, a scope without a user, or a lookup that fails is not a
// super-admin: the refusal stands (fail closed).
import 'server-only';
import type { ServiceScope } from '@/lib/services/types';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { createServiceClient } from '@/lib/supabase/server';

export async function isSuperAdminCaller(scope: Pick<ServiceScope, 'userId' | 'actorKind'>): Promise<boolean> {
  if (!scope.userId || scope.actorKind === 'system') return false;
  try {
    const { data, error } = await createServiceClient().auth.admin.getUserById(scope.userId);
    if (error) {
      console.error('[super-admin-caller] user lookup failed; the allowance refusal stands', error);
      return false;
    }
    return isSuperAdminEmail(data.user?.email);
  } catch (err) {
    console.error('[super-admin-caller] user lookup threw; the allowance refusal stands', err);
    return false;
  }
}
