import { describe, expect, it } from 'vitest';
import {
  STEP_UP_ROUTE,
  classifyMfaError,
  hasVerifiedTotp,
  isSafeReturnPath,
  isValidTotpCode,
  mfaUiState,
  needsStepUp,
  normalizeTotpCode,
  pendingTotpFactors,
  sessionStrength,
  stepUpPath,
  verifiedTotpFactors,
  type MfaFactor,
} from '@/lib/auth/mfa';

// lib/auth/mfa.ts is the one place the Settings panel, the step-up page and
// the server guard agree on what "enrolled" and "needs a code" mean. These
// tests pin the raw Supabase facts → product state mapping, so the UI can
// never say "on" for a factor Supabase still lists as unverified, and the
// guard can never stop a family that has no factor at all.

function factor(over: Partial<MfaFactor> = {}): MfaFactor {
  return { id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: 'Bubaly 2026-09-07', created_at: '2026-09-07T10:00:00Z', ...over };
}

describe('factor lists', () => {
  it('separates verified TOTP factors from unfinished enrolments and ignores other factor types', () => {
    const factors = [
      factor({ id: 'ok' }),
      factor({ id: 'pending', status: 'unverified' }),
      factor({ id: 'phone', factor_type: 'phone' }),
    ];
    expect(verifiedTotpFactors(factors).map((f) => f.id)).toEqual(['ok']);
    expect(pendingTotpFactors(factors).map((f) => f.id)).toEqual(['pending']);
    expect(hasVerifiedTotp(factors)).toBe(true);
    expect(hasVerifiedTotp(null)).toBe(false);
    expect(hasVerifiedTotp([factor({ status: 'unverified' })])).toBe(false);
  });

  it('maps a factor list onto the three panel states', () => {
    expect(mfaUiState([])).toBe('not_enrolled');
    expect(mfaUiState(undefined)).toBe('not_enrolled');
    // An unverified factor is NOT "enrolled": Supabase keeps it around, and
    // the honest panel state is "an earlier setup was never finished".
    expect(mfaUiState([factor({ status: 'unverified' })])).toBe('pending_verification');
    expect(mfaUiState([factor(), factor({ id: 'f2', status: 'unverified' })])).toBe('enrolled');
  });
});

describe('session strength and the step-up decision', () => {
  it('reads Supabase\'s current/next levels into one of three strengths', () => {
    expect(sessionStrength({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe('password_only');
    expect(sessionStrength({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe('needs_step_up');
    expect(sessionStrength({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe('stepped_up');
    expect(sessionStrength({ currentLevel: null, nextLevel: null })).toBe('password_only');
  });

  it('asks a manager with a verified factor and an aal1 session for a code', () => {
    expect(needsStepUp({ role: 'parent', assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } })).toBe(true);
    expect(needsStepUp({ role: 'adult', assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } })).toBe(true);
  });

  it('never stops a family with no factor, and never stops a session that already stepped up', () => {
    expect(needsStepUp({ role: 'parent', assurance: { currentLevel: 'aal1', nextLevel: 'aal1' } })).toBe(false);
    expect(needsStepUp({ role: 'parent', assurance: { currentLevel: 'aal2', nextLevel: 'aal2' } })).toBe(false);
  });

  it('leaves non-manager roles alone even when they enrolled an authenticator', () => {
    for (const role of ['teen', 'child', 'caregiver', 'guest', null, undefined]) {
      expect(needsStepUp({ role, assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } }), String(role)).toBe(false);
    }
  });
});

describe('return paths', () => {
  it('accepts only same-origin absolute paths that are not the step-up page itself', () => {
    expect(isSafeReturnPath('/dashboard/expenses')).toBe(true);
    expect(isSafeReturnPath('/dashboard/settings#privacy')).toBe(true);
    expect(isSafeReturnPath('https://evil.example/')).toBe(false);
    expect(isSafeReturnPath('//evil.example')).toBe(false);
    expect(isSafeReturnPath('/\\evil.example')).toBe(false);
    expect(isSafeReturnPath('dashboard')).toBe(false);
    expect(isSafeReturnPath('/x\r\nSet-Cookie: a=b')).toBe(false);
    expect(isSafeReturnPath(STEP_UP_ROUTE)).toBe(false);
    expect(isSafeReturnPath(`${STEP_UP_ROUTE}?next=%2Fdashboard`)).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
    expect(isSafeReturnPath('')).toBe(false);
  });

  it('builds the step-up URL with the return path encoded, falling back to the dashboard for an unsafe one', () => {
    expect(stepUpPath('/dashboard/trust')).toBe('/auth/step-up?next=%2Fdashboard%2Ftrust');
    expect(stepUpPath('https://evil.example')).toBe('/auth/step-up?next=%2Fdashboard');
  });
});

describe('TOTP codes', () => {
  it('accepts six digits, with the spaces people type between groups removed', () => {
    expect(normalizeTotpCode('123 456')).toBe('123456');
    expect(isValidTotpCode('123 456')).toBe(true);
    expect(isValidTotpCode('123456')).toBe(true);
    expect(isValidTotpCode('12345')).toBe(false);
    expect(isValidTotpCode('1234567')).toBe(false);
    expect(isValidTotpCode('12a456')).toBe(false);
  });
});

describe('classifyMfaError', () => {
  it('sorts Supabase Auth error codes into the states the UI words differently, keeping Supabase\'s message', () => {
    const cases: [string, string][] = [
      ['mfa_totp_enroll_not_enabled', 'not_enabled'],
      ['mfa_totp_verify_not_enabled', 'not_enabled'],
      ['mfa_verification_failed', 'invalid_code'],
      ['mfa_verification_rejected', 'invalid_code'],
      ['mfa_challenge_expired', 'expired'],
      ['insufficient_aal', 'insufficient_aal'],
      ['mfa_factor_name_conflict', 'name_conflict'],
      ['too_many_enrolled_mfa_factors', 'too_many_factors'],
      ['mfa_factor_not_found', 'factor_not_found'],
      ['over_request_rate_limit', 'rate_limited'],
    ];
    for (const [code, kind] of cases) {
      const out = classifyMfaError({ code, message: `supabase: ${code}`, status: 422 });
      expect(out.kind, code).toBe(kind);
      expect(out.code).toBe(code);
      expect(out.message).toBe(`supabase: ${code}`);
    }
  });

  it('falls back to the message for older GoTrue builds that send no code, and to unknown otherwise', () => {
    expect(classifyMfaError({ message: 'MFA enroll is disabled for TOTP' }).kind).toBe('not_enabled');
    expect(classifyMfaError({ message: 'Invalid TOTP code entered' }).kind).toBe('invalid_code');
    expect(classifyMfaError({ message: 'AAL2 required to unenroll a verified factor' }).kind).toBe('insufficient_aal');
    expect(classifyMfaError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }).kind).toBe('network');
    expect(classifyMfaError({ status: 429, message: 'slow down' }).kind).toBe('rate_limited');
    expect(classifyMfaError(new Error('boom'))).toEqual({ kind: 'unknown', code: null, message: 'boom' });
    expect(classifyMfaError(null)).toEqual({ kind: 'unknown', code: null, message: '' });
    expect(classifyMfaError('a string')).toMatchObject({ kind: 'unknown', message: 'a string' });
  });
});
