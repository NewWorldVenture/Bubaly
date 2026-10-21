// lib/auth/signed-in-user.ts — who is calling, on a surface that does not care
// much: a PUBLIC action that serves strangers and merely treats a member
// differently (the review form's moderation, audit N4).
import 'server-only';

import { getUser } from '@/lib/supabase/auth';

/**
 * The signed-in user's id, or null.
 *
 * Not a guard: nothing is refused on null, so it is deliberately not one of the
 * names tests/every-server-action-reaches-auth.test.ts credits as establishing
 * the caller. Unlike `getUser` it never throws, because on a public surface a
 * transient auth failure has the same safe answer as a signed-out visitor —
 * the one that owes the caller nothing extra.
 */
export async function signedInUserId(): Promise<string | null> {
  try {
    return (await getUser())?.id ?? null;
  } catch {
    return null;
  }
}
