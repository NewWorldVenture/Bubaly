// lib/auth/mfa.ts — the pure half of two-step sign-in.
//
// Supabase Auth owns the factors (there is no Bubaly table for them): a person
// enrols a TOTP authenticator through `supabase.auth.mfa.enroll`, proves it with
// `challengeAndVerify`, and from then on a session is either `aal1` (password
// only) or `aal2` (password + a fresh code). Everything that turns those raw
// facts into a UI state or a routing decision lives here, with no client or
// server import, so the Settings panel, the step-up page and the server guard
// all agree on what "enrolled" and "needs a code" mean — and so the decisions
// can be tested without a browser or a database.

export type FactorStatus = 'verified' | 'unverified';

/** The subset of Supabase's `Factor` the product reads. */
export type MfaFactor = {
  id: string;
  factor_type: string;
  status: FactorStatus | (string & {});
  friendly_name?: string | null;
  created_at: string;
  updated_at?: string;
  last_challenged_at?: string | null;
};

/** `aal1` = password only; `aal2` = a second factor was verified this session. */
export type AssuranceLevel = 'aal1' | 'aal2';

export type Assurance = {
  currentLevel: string | null;
  nextLevel: string | null;
};

/** The route the server sends an `aal1` session to when a route needs `aal2`. */
export const STEP_UP_ROUTE = '/auth/step-up';

/** A TOTP code is six digits; spaces people type between groups are dropped. */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export function isValidTotpCode(raw: string): boolean {
  return /^\d{6}$/.test(normalizeTotpCode(raw));
}

/** The authenticator factors a person has finished setting up. */
export function verifiedTotpFactors(factors: readonly MfaFactor[] | null | undefined): MfaFactor[] {
  return (factors ?? []).filter((f) => f.factor_type === 'totp' && f.status === 'verified');
}

/**
 * Enrolments started and never proved. Supabase keeps these around; a panel
 * that ignored them would show "not enrolled" and then fail the next enrol
 * with `mfa_factor_name_conflict`, so the UI cleans them up before starting over.
 */
export function pendingTotpFactors(factors: readonly MfaFactor[] | null | undefined): MfaFactor[] {
  return (factors ?? []).filter((f) => f.factor_type === 'totp' && f.status !== 'verified');
}

export function hasVerifiedTotp(factors: readonly MfaFactor[] | null | undefined): boolean {
  return verifiedTotpFactors(factors).length > 0;
}

export type MfaUiState = 'not_enrolled' | 'pending_verification' | 'enrolled';

/** What the Settings › Security panel should show for a factor list. */
export function mfaUiState(factors: readonly MfaFactor[] | null | undefined): MfaUiState {
  if (hasVerifiedTotp(factors)) return 'enrolled';
  if (pendingTotpFactors(factors).length > 0) return 'pending_verification';
  return 'not_enrolled';
}

export type SessionStrength =
  /** No verified factor: the password is all there is. */
  | 'password_only'
  /** A factor is enrolled and this session proved it. */
  | 'stepped_up'
  /** A factor is enrolled but this session has not entered a code yet. */
  | 'needs_step_up';

/**
 * Supabase's `getAuthenticatorAssuranceLevel` answers with the level the
 * session HAS and the level it COULD reach. The gap between them is the one
 * fact a step-up decision needs.
 */
export function sessionStrength(assurance: Assurance): SessionStrength {
  if (assurance.currentLevel === 'aal2') return 'stepped_up';
  if (assurance.nextLevel === 'aal2') return 'needs_step_up';
  return 'password_only';
}

/**
 * Whether a route that handles money, documents or trust should send this
 * session to the step-up page.
 *
 * Only a session that CAN reach `aal2` is asked to: a family that never
 * enrolled a factor is unaffected, which is what keeps this an opt-in control
 * rather than a surprise lock-out. Enforcement is for managers — the roles that
 * can read finances and sensitive documents at all (`assertFinanceReader`,
 * `canReadSensitive`); a teen who enrolled an authenticator for their own
 * account is not stopped at a page RLS already limits for them.
 */
export function needsStepUp(input: { role: string | null | undefined; assurance: Assurance }): boolean {
  const manager = input.role === 'parent' || input.role === 'adult';
  return manager && sessionStrength(input.assurance) === 'needs_step_up';
}

/**
 * A return path the step-up page may send a person back to: same-origin,
 * absolute, and not a protocol-relative `//evil.example` that `redirect()`
 * would happily follow off-site.
 */
export function isSafeReturnPath(next: string | null | undefined): next is string {
  if (!next || typeof next !== 'string') return false;
  if (!next.startsWith('/')) return false;
  if (next.startsWith('//') || next.startsWith('/\\')) return false;
  if (/[\r\n]/.test(next)) return false;
  // The step-up page itself is never a destination; that would loop.
  if (next === STEP_UP_ROUTE || next.startsWith(`${STEP_UP_ROUTE}?`)) return false;
  return true;
}

/** Where to send an `aal1` session so it can come back to `returnTo` afterwards. */
export function stepUpPath(returnTo: string): string {
  const safe = isSafeReturnPath(returnTo) ? returnTo : '/dashboard';
  return `${STEP_UP_ROUTE}?next=${encodeURIComponent(safe)}`;
}

export type MfaErrorKind =
  /** The Supabase project has TOTP enrolment/verification switched off. */
  | 'not_enabled'
  /** The six digits did not match (or were rejected). */
  | 'invalid_code'
  /** The challenge outlived its window; ask for a fresh code. */
  | 'expired'
  /** The action (unenrol, mostly) needs an `aal2` session first. */
  | 'insufficient_aal'
  /** An unverified factor with the same name is already there. */
  | 'name_conflict'
  | 'too_many_factors'
  | 'factor_not_found'
  | 'rate_limited'
  | 'network'
  | 'unknown';

export type ClassifiedMfaError = {
  kind: MfaErrorKind;
  /** Supabase's machine code when it sent one (`mfa_verification_failed`, …). */
  code: string | null;
  /** Supabase's own words, kept so the panel can show them next to ours. */
  message: string;
};

/**
 * Sort a Supabase Auth error into the handful of states the UI words
 * differently. The raw message is preserved on every branch: "MFA enroll is
 * disabled for TOTP" is more useful to the owner who has to flip the project
 * setting than any paraphrase would be.
 */
export function classifyMfaError(error: unknown): ClassifiedMfaError {
  const obj = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown; status?: unknown; name?: unknown };
  const code = typeof obj.code === 'string' ? obj.code : null;
  const message = typeof obj.message === 'string' ? obj.message : typeof error === 'string' ? error : '';
  const lower = message.toLowerCase();

  const kind = ((): MfaErrorKind => {
    switch (code) {
      case 'mfa_totp_enroll_not_enabled':
      case 'mfa_totp_verify_not_enabled':
        return 'not_enabled';
      case 'mfa_verification_failed':
      case 'mfa_verification_rejected':
        return 'invalid_code';
      case 'mfa_challenge_expired':
        return 'expired';
      case 'insufficient_aal':
        return 'insufficient_aal';
      case 'mfa_factor_name_conflict':
        return 'name_conflict';
      case 'too_many_enrolled_mfa_factors':
        return 'too_many_factors';
      case 'mfa_factor_not_found':
        return 'factor_not_found';
      case 'over_request_rate_limit':
        return 'rate_limited';
      default:
        break;
    }
    if (obj.status === 429) return 'rate_limited';
    // Older GoTrue builds send only a message.
    if (lower.includes('not enabled') || lower.includes('is disabled')) return 'not_enabled';
    if (lower.includes('invalid totp') || lower.includes('invalid code')) return 'invalid_code';
    if (lower.includes('expired')) return 'expired';
    if (lower.includes('aal2') || lower.includes('assurance')) return 'insufficient_aal';
    if (lower.includes('failed to fetch') || lower.includes('network') || obj.name === 'AuthRetryableFetchError') return 'network';
    return 'unknown';
  })();

  return { kind, code, message };
}
