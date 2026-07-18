import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 7 — forms & keyboard):
//  1. iOS/iPadOS Safari zooms the page when a focused input's font-size is < 16px.
//     A global rule forces >=16px on touch devices, but it MUST use `!important`
//     (and a class the many `text-sm`/`text-xs` inputs can't out-specify) or the
//     zoom returns. Also must cover tablets (coarse pointer), not just narrow width.
//  2. Auth fields must carry the right type + autocomplete so mobile shows the
//     correct keyboard and password managers / OTP autofill work.

const css = fs.readFileSync('app/globals.css', 'utf8');
const loginForm = fs.readFileSync('components/auth/login-form.tsx', 'utf8');
const otp = fs.readFileSync('components/ui/otp-input.tsx', 'utf8');
const phone = fs.readFileSync('components/ui/phone-input.tsx', 'utf8');

describe('mobile inputs avoid iOS zoom-on-focus (>=16px, enforced)', () => {
  it('the 16px input rule uses !important so Tailwind text-sm cannot override it', () => {
    // Grab the block that sets the 16px font on inputs.
    const idx = css.indexOf('font-size: 16px');
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(Math.max(0, idx - 400), idx + 60);
    expect(block).toContain('font-size: 16px !important');
  });

  it('the rule covers touch tablets (coarse pointer), not only narrow phones', () => {
    expect(css).toMatch(/@media \(max-width: 640px\), \(pointer: coarse\)/);
  });
});

describe('auth + specialized inputs expose correct mobile keyboard semantics', () => {
  it('login email/password use the right type + autocomplete', () => {
    expect(loginForm).toContain('type="email"');
    expect(loginForm).toContain('autoComplete="email"');
    expect(loginForm).toContain('type="password"');
    expect(loginForm).toContain('autoComplete="current-password"');
  });

  it('OTP input requests the numeric keyboard + one-time-code autofill', () => {
    expect(otp).toContain('inputMode="numeric"');
    expect(otp).toContain("'one-time-code'");
  });

  it('phone input requests the tel keyboard', () => {
    expect(phone).toContain('type="tel"');
    expect(phone).toContain('inputMode="tel"');
  });
});
