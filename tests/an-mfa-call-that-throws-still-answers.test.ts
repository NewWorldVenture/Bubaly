// ROLE-L04: auth-js answers an MFA AuthError as `{ error }` but rethrows any
// other failure (a lock-acquire timeout, for one). The step-up form and the
// Settings security panel read only `{ error }`, so a throw left the button
// spinning — the step-up page with no way forward and no message. Every MFA
// call in the UI now goes through settleMfaCall, which turns a throw into the
// same `{ error }` the forms already classify and show.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyMfaError, settleMfaCall } from '@/lib/auth/mfa';

const FILES = ['components/auth/step-up-form.tsx', 'components/settings/security-panel.tsx'];

describe('an MFA call that throws still answers', () => {
  it('turns a throw into { error }', async () => {
    const lock = new Error('Acquiring an exclusive Navigator LockManager lock timed out');
    const settled = await settleMfaCall(async (): Promise<{ data: null; error: null }> => { throw lock; });
    expect(settled).toEqual({ data: null, error: lock });
    expect(classifyMfaError(settled.error).message).toBe(lock.message);
    const thrownString = await settleMfaCall(async (): Promise<{ error: null }> => { throw 'boom'; });
    expect(thrownString.error).toBeInstanceOf(Error);
  });

  it('passes an answer through untouched', async () => {
    const answer = { data: { id: 'f1' }, error: null };
    expect(await settleMfaCall(async () => answer)).toBe(answer);
  });

  it('every MFA call in the UI goes through it', () => {
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      const calls = source.match(/auth\.mfa\.(challengeAndVerify|verify|challenge|enroll|unenroll|listFactors|getAuthenticatorAssuranceLevel)\(/g) ?? [];
      const settled = source.match(/settleMfaCall\(\(\) => [\w().]*auth\.mfa\.\w+\(/g) ?? [];
      // step-up's factor read keeps its own .catch (it predates the helper).
      const ownCatch = file.includes('step-up') && /listFactors\(\)\.then\([\s\S]*?\.catch\(/.test(source) ? 1 : 0;
      expect(calls.length, file).toBeGreaterThan(0);
      expect(settled.length + ownCatch, file).toBe(calls.length);
    }
  });
});
