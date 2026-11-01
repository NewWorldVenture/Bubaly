import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A11Y-001, WCAG 2.4.3: the phone sign-in form replaces the button that opens
// it, and Back replaces the form with the buttons again. A screen reader
// (Orca on Chromium) found focus left on the page itself both ways. The form
// focuses its number field when it appears; Back returns focus to the button
// that opened it. Rendered in tests/e2e/a-popup-opens-closes-and-keeps-its-targets-apart.spec.ts.

const read = (f: string) => readFileSync(f, 'utf8');

describe('a swapped sign-in form keeps focus', () => {
  it('the phone form focuses its number field', () => {
    expect(read('components/auth/phone-auth.tsx')).toContain('<PhoneInput defaultCountryCode="US" onChange={changePhone} autoFocus />');
    const input = read('components/ui/phone-input.tsx');
    expect(input).toContain("aria-label={tr('phoneInput.phoneNumber')}\n          autoFocus={autoFocus}");
  });

  it('log-in: Back returns focus to "Continue with phone"', () => {
    const src = read('components/auth/login-form.tsx');
    expect(src).toContain('{ refocusPhoneButton.current = true; setShowPhone(false); }');
    expect(src).toContain('if (!showPhone && refocusPhoneButton.current) { refocusPhoneButton.current = false; phoneButton.current?.focus(); }');
    expect(src).toMatch(/<button\s+ref=\{phoneButton\}/);
  });

  it('sign-up: Back returns focus to whichever of its two buttons opened the form', () => {
    const src = read('components/auth/signup-form.tsx');
    expect(src).toContain('{ refocusPhoneOpener.current = true; setShowPhone(false); }');
    expect(src).toContain("(phoneOpener.current === 'noEmail' ? noEmailButton : phoneButton).current?.focus();");
    expect(src).toContain("{ phoneOpener.current = 'phone'; setShowPhone(true); }");
    expect(src).toContain("{ phoneOpener.current = 'noEmail'; setShowPhone(true); }");
    expect(src).toMatch(/<button\s+ref=\{phoneButton\}/);
    expect(src).toMatch(/<button\s+ref=\{noEmailButton\}/);
  });
});
