// lib/auth/super-admin-assurance.ts — two-step sign-in for the admin console.
//
// Super-admin is decided by email (isSuperAdmin), which says nothing about HOW
// the session signed in. The money, documents and trust pages already send a
// password-only (`aal1`) session of an account with a verified authenticator to
// /auth/step-up; the admin console, which can grant super-admin, replace the
// platform Stripe keys and ban accounts, did not. So someone holding only an
// MFA-enrolled admin's password was stopped at the household's bill list and
// waved through the whole site.
//
// Every admin gate (the /admin layout, assertSuperAdmin, superAdminGate,
// requireMarketingAdmin, the /admin action guards and the /api/admin routes)
// asks this module once the email check has said yes. A session that can reach
// `aal2` and has not is refused; a level that cannot be read is refused too
// (fail closed, as requireAal2 does). An admin with no factor enrolled is
// allowed — the same opt-in rule as the rest of the app.
import 'server-only';
import { createServer } from '@/lib/supabase/server';
import { readAssurance, type AssuranceRead } from './require-aal2';
import { sessionStrength, stepUpPath } from './mfa';

export type SuperAdminAssurance =
  | { ok: true }
  | { ok: false; reason: 'needs_code' | 'assurance_unreadable' };

/** Where the /admin layout sends a session that still owes a code. */
export const SUPER_ADMIN_STEP_UP_PATH = stepUpPath('/admin');

export function decideSuperAdminAssurance(read: AssuranceRead): SuperAdminAssurance {
  if (!read.ok) return { ok: false, reason: 'assurance_unreadable' };
  if (sessionStrength(read.assurance) === 'needs_step_up') return { ok: false, reason: 'needs_code' };
  return { ok: true };
}

/** The assurance verdict for the signed-in (cookie) session. Never throws. */
export async function superAdminAssurance(): Promise<SuperAdminAssurance> {
  let read: AssuranceRead;
  try {
    read = await readAssurance(await createServer());
  } catch (error) {
    read = { ok: false, error };
  }
  if (!read.ok) console.error('[auth/super-admin] assurance level read failed', read.error);
  return decideSuperAdminAssurance(read);
}
