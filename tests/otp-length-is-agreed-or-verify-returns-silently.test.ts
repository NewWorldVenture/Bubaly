import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidOtp, normalizeOtp } from '@/lib/auth/otp';

// A coupling with no guard, found while tracing why the phone-auth E2E cases
// never issue their POST /auth/v1/verify.
//
// The submit path for a pasted code runs:
//
//   otp-input.tsx:78-85   pasted = raw.replace(/\D/g,'').slice(0, LENGTH)
//                         onChange(pasted)  -> changeCode
//                         onComplete(pasted) -> verify(pasted)
//   phone-auth.tsx:104    intent.current.code = normalizeOtp(pasted)
//   phone-auth.tsx:152    if (!isValidOtp(token) || token !== intent.current.code) return;
//
// That last line is a SILENT return. No throw, no toast, no request — the user
// presses nothing and nothing happens.
//
// It is safe today only because two numbers agree by coincidence of authorship:
// OtpInput's `length` defaults to 6, and normalizeOtp hard-codes slice(0, 6).
// phone-auth renders <OtpInput> WITHOUT a length prop, so it inherits the
// default. Nothing anywhere states that these must match.
//
// Give phone auth an 8-digit code — `<OtpInput length={8}>`, a one-word change
// a provider migration could plausibly ask for — and the chain becomes:
// pasted is 8 digits, normalizeOtp truncates it to 6, token !== intent.code,
// and verify() returns silently. The form fills in, the button enables, and no
// verification is ever attempted.
//
// That failure is indistinguishable from the one currently red in CI, which is
// the reason this guard is worth having even though the two are not the same
// bug: the next person to see "the digits are there and no request went out"
// should be able to rule this out in one test run instead of re-deriving it.
//
// Source-shape assertions are used deliberately for the wiring half. There is
// no DOM environment in this suite (no jsdom, happy-dom or testing-library),
// so the component cannot be rendered and its paste handler cannot be fired.
// What CAN be pinned without one is that the two numbers still agree, which is
// the whole of the hazard.

const OTP_SOURCE = readFileSync('lib/auth/otp.ts', 'utf8');
const INPUT_SOURCE = readFileSync('components/ui/otp-input.tsx', 'utf8');
const PHONE_SOURCE = readFileSync('components/auth/phone-auth.tsx', 'utf8');

/** What OtpInput would emit for a complete paste of `length` digits. */
const emittedByInput = (raw: string, length: number) =>
  raw.replace(/\D/g, '').slice(0, length);

describe('the OTP length is agreed, or verify() returns silently', () => {
  it('normalizeOtp is a no-op on anything OtpInput can emit at length 6', () => {
    // The property the guard at phone-auth.tsx:152 depends on. If this ever
    // stops holding, a pasted code stops being verifiable.
    for (const raw of ['483921', '000000', '4-8-3-9-2-1', ' 483921 ', '483921abc']) {
      const emitted = emittedByInput(raw, 6);
      expect(normalizeOtp(emitted), `normalizeOtp changed ${emitted}`).toBe(emitted);
      expect(isValidOtp(emitted)).toBe(true);
    }
  });

  it('shows the failure directly: at length 8 the guard silently rejects', () => {
    // Not hypothetical — this is arithmetic on the two functions as written.
    // It is asserted so the consequence is on the record rather than in a
    // comment, and so the test above is not mistaken for a tautology.
    const emitted = emittedByInput('48392177', 8);
    expect(emitted).toBe('48392177');
    expect(normalizeOtp(emitted)).toBe('483921');
    expect(normalizeOtp(emitted)).not.toBe(emitted); // -> token !== intent.code -> return
  });

  it('normalizeOtp and isValidOtp are both pinned to 6', () => {
    expect(OTP_SOURCE).toMatch(/slice\(0,\s*6\)/);
    expect(OTP_SOURCE).toMatch(/\^\\d\{6\}\$/);
  });

  it("OtpInput's default length is 6", () => {
    expect(INPUT_SOURCE).toMatch(/length\s*=\s*6\s*,/);
  });

  it('phone auth does not override that default', () => {
    // The one line that would break the coupling. If a future change needs a
    // different length for phone auth, normalizeOtp and isValidOtp have to move
    // with it — and this test is where that is said.
    const usage = PHONE_SOURCE.slice(PHONE_SOURCE.indexOf('<OtpInput'));
    const tag = usage.slice(0, usage.indexOf('/>') + 2);
    expect(tag, 'phone-auth renders OtpInput').toContain('onComplete');
    expect(tag, 'a length prop here must be 6, or verify() will silently no-op')
      .not.toMatch(/length=\{(?!6\})/);
  });

  it('the scan is not vacuous — it really is reading those files', () => {
    // Each assertion above is a `toMatch` on file text, which passes just as
    // happily against a file that was never read.
    expect(OTP_SOURCE).toContain('export function normalizeOtp');
    expect(INPUT_SOURCE).toContain('function handlePaste');
    expect(PHONE_SOURCE).toContain('intent.current.code');
  });
});
