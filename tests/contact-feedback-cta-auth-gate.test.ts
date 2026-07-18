import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// PLA-0836: on /contact, "Share an idea or request" must gate on auth — a
// logged-out visitor is sent to log in first and returned to /feedback
// afterwards (login-form honours ?redirect=). A logged-in visitor goes straight
// to /feedback.
const page = readFileSync('app/(marketing)/contact/page.tsx', 'utf8');

describe('contact feedback CTA auth gate', () => {
  it('branches the CTA on login state', () => {
    expect(page).toContain('const loggedIn = !!user;');
    expect(page).toContain('{loggedIn ? (');
  });

  it('logged-out: routes to login with a redirect back to /feedback', () => {
    expect(page).toContain('href="/login?redirect=%2Ffeedback"');
    // both states present the same primary CTA label
    expect(page.match(/Share an idea or request/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('logged-in: goes straight to /feedback', () => {
    expect(page).toContain('href="/feedback"');
  });
});
