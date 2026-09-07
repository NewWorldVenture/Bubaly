// lib/auth/require-aal2.ts — the server half of two-step sign-in.
//
// Money, documents and trust pages call `requireAal2` right after their
// `requireUserContext` / `requireFeature` guard. For a manager whose account
// has a verified authenticator, an `aal1` session (password only) is sent to
// `/auth/step-up` and comes back once a code has been entered. Families that
// never enrolled a factor are not touched: the guard answers "allow" without
// a redirect, because `nextLevel` is `aal1` for them.
//
// The assurance level is read from the session's JWT (`aal` claim) by
// `getAuthenticatorAssuranceLevel`; it is not a network round-trip. When even
// that read fails, the guard FAILS CLOSED: it does not let the page render on
// a level it could not establish. It sends the session to the step-up page,
// which re-reads and shows an honest, retryable error rather than a page of
// finances behind a guard that silently gave up.
import 'server-only';
import { redirect } from 'next/navigation';
import { createServer } from '@/lib/supabase/server';
import type { UserContext } from '@/lib/supabase/auth';
import { needsStepUp, stepUpPath, type Assurance } from './mfa';

/** The three surfaces the strategy names for step-up. */
export type Aal2Area = 'money' | 'documents' | 'trust';

export type AssuranceRead =
  | { ok: true; assurance: Assurance }
  | { ok: false; error: unknown };

/** The narrow client surface the guard needs, so tests can hand in a stub. */
export type AssuranceReader = {
  auth: { mfa: { getAuthenticatorAssuranceLevel: () => Promise<{ data: { currentLevel: string | null; nextLevel: string | null } | null; error: unknown }> } };
};

export async function readAssurance(client: AssuranceReader): Promise<AssuranceRead> {
  try {
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return { ok: false, error: error ?? new Error('assurance level missing') };
    return { ok: true, assurance: { currentLevel: data.currentLevel, nextLevel: data.nextLevel } };
  } catch (error) {
    return { ok: false, error };
  }
}

export type Aal2Decision =
  | { action: 'allow' }
  | { action: 'step_up'; to: string; reason: 'needs_code' | 'assurance_unreadable' };

/**
 * The decision, separated from the redirect so it can be tested and so a
 * route handler can answer JSON with it instead of redirecting.
 */
export function decideAal2(input: { role: string | null | undefined; read: AssuranceRead; returnTo: string }): Aal2Decision {
  if (!input.read.ok) return { action: 'step_up', to: stepUpPath(input.returnTo), reason: 'assurance_unreadable' };
  if (needsStepUp({ role: input.role, assurance: input.read.assurance })) {
    return { action: 'step_up', to: stepUpPath(input.returnTo), reason: 'needs_code' };
  }
  return { action: 'allow' };
}

/**
 * The verdict for the signed-in caller, without acting on it. Route handlers
 * use this to answer `403 step_up_required` where a page would redirect.
 */
export async function aal2Verdict(ctx: UserContext, area: Aal2Area, returnTo: string): Promise<Aal2Decision> {
  const supabase = await createServer();
  const read = await readAssurance(supabase);
  if (!read.ok) console.error(`[auth/aal2] ${area} assurance level read failed`, read.error);
  return decideAal2({ role: ctx.active.role, read, returnTo });
}

/**
 * Page guard. Call it after `requireUserContext()` (or `requireFeature()`,
 * which returns the same context) and before reading anything sensitive.
 * Redirects when a code is needed; returns when the page may render.
 */
export async function requireAal2(ctx: UserContext, area: Aal2Area, returnTo: string): Promise<void> {
  const decision = await aal2Verdict(ctx, area, returnTo);
  if (decision.action === 'step_up') redirect(decision.to);
}
