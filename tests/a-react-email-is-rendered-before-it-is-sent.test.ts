import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A React email is rendered, not dropped.
//
// sendReactEmail hands Resend a React element (`react:`), and the SDK turns it
// into HTML by dynamically importing @react-email/render — an OPTIONAL peer of
// `resend` that nothing installed. The import failed, the SDK threw "Failed to
// render React component. Make sure to install `@react-email/render`",
// sendReactEmail caught that and answered `{ ok: false }`: in any deployment with
// RESEND_API_KEY set, every React email (welcome, invite, referral, weekly
// digest, chore reminders, notification digest) failed before reaching Resend.
// tests/email-send-contract.test.ts mocks `resend` whole, so no test ever ran
// the render step.
//
// This file does NOT mock `resend`. The real SDK renders the real templates
// with the real renderer; only `fetch` is replaced, at the provider's HTTP
// boundary, so nothing leaves the process and no email is sent.

const { WelcomeEmail } = await import('@/lib/emails/welcome');
const { InviteEmail } = await import('@/lib/emails/invite');
const { ReferralEmail } = await import('@/lib/emails/referral');
const { WeeklyDigestEmail } = await import('@/lib/emails/weekly-digest');
const { ChoreReminderEmail } = await import('@/lib/emails/chore-reminder');
const { NotificationDigestEmail } = await import('@/lib/emails/notification-digest');

const ORIGINAL_KEY = process.env.RESEND_API_KEY;
const RESEND_EMAILS = 'https://api.resend.com/emails';

type Posted = { url: string; body: Record<string, unknown> };
let posted: Posted[];
let stray: string[];

beforeEach(() => {
  posted = [];
  stray = [];
  process.env.RESEND_API_KEY = 're_test_key_not_real';
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url !== RESEND_EMAILS) { stray.push(url); throw new Error('network disabled in this test'); }
    posted.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: `synthetic-${posted.length}` }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  expect(stray).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
});

async function freshSend() {
  // lib/email.ts memoises its Resend client; each case gets its own.
  vi.resetModules();
  return (await import('@/lib/email')).sendReactEmail;
}

/** React separates adjacent text nodes with `<!-- -->`; read the text as a person would. */
const visible = (html: string) => html.replace(/<!-- -->/g, '');

async function sendOne(react: ReactElement) {
  const sendReactEmail = await freshSend();
  const result = await sendReactEmail({ to: 'parent@example.test', subject: 'Synthetic', react });
  return { result, only: posted.length === 1 ? posted[0] : null };
}

describe('the renderer the SDK imports is installed', () => {
  it('resolves @react-email/render from where `resend` imports it, not merely from the app', () => {
    const fromApp = createRequire(import.meta.url);
    const fromResend = createRequire(fromApp.resolve('resend'));
    expect(() => fromResend.resolve('@react-email/render')).not.toThrow();
    expect(dirname(fromResend.resolve('@react-email/render'))).toMatch(/node_modules[\\/]@react-email[\\/]render[\\/]/);
  });

  it('is a runtime dependency, not a dev-only one, so a production install keeps it', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@react-email/render']).toBeTruthy();
    expect(pkg.devDependencies?.['@react-email/render']).toBeUndefined();
  });
});

describe('sendReactEmail renders every template through the real SDK', () => {
  const cases: [string, () => ReactElement, string[]][] = [
    ['welcome', () => createElement(WelcomeEmail, { name: 'Ada' }), ['Welcome to Bubaly, Ada!']],
    ['invite', () => createElement(InviteEmail, {
      familyName: 'The Synthetic Family', inviterName: 'Grace', token: 'tok-synthetic', role: 'parent',
    }), ['The Synthetic Family', 'Grace', 'tok-synthetic']],
    ['referral', () => createElement(ReferralEmail, {
      inviterName: 'Grace', familyName: 'The Synthetic Family', code: 'SYNTH-42',
      link: 'https://example.test/r/SYNTH-42', rewardLabel: 'a free month',
    }), ['SYNTH-42', 'https://example.test/r/SYNTH-42']],
    ['weekly digest', () => createElement(WeeklyDigestEmail, {
      familyName: 'The Synthetic Family', adminName: 'Ada',
      events: [{ title: 'Synthetic recital', date: '2026-10-02' }],
      openChores: 3, mealsPlanned: 5, memberCount: 4,
    }), ['The Synthetic Family', 'Synthetic recital']],
    ['chore reminder', () => createElement(ChoreReminderEmail, {
      memberName: 'Ada', familyName: 'The Synthetic Family',
      chores: [{ title: 'Water the synthetic plants', points: 5, dueAt: null }],
    }), ['Ada', 'Water the synthetic plants']],
    ['notification digest', () => createElement(NotificationDigestEmail, {
      name: 'Ada', items: [{ title: 'Synthetic notice', body: 'Nothing real happened.', icon: 'bell' }],
    }), ['Synthetic notice', 'Nothing real happened.']],
  ];

  it.each(cases)('%s: answers { ok: true } and posts rendered HTML, not a React element', async (_name, make, expected) => {
    const { result, only } = await sendOne(make());
    expect(result).toEqual({ ok: true });
    expect(only).not.toBeNull();
    const html = only!.body.html;
    expect(typeof html).toBe('string');
    expect(html as string).toMatch(/^<!DOCTYPE html/i);
    for (const text of expected) expect(visible(html as string)).toContain(text);
    expect(only!.body).not.toHaveProperty('react');
    expect(only!.body).toMatchObject({ to: 'parent@example.test', subject: 'Synthetic' });
  });

  it('escapes what a family typed: markup in a name arrives as text, never as HTML', async () => {
    const { result, only } = await sendOne(createElement(WelcomeEmail, { name: '<script>alert(1)</script>' }));
    expect(result).toEqual({ ok: true });
    const html = only!.body.html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(visible(html)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('a template that throws while rendering is { ok: false } and nothing is posted', async () => {
    const Broken = () => { throw new Error('synthetic render failure'); };
    const { result } = await sendOne(createElement(Broken));
    expect(result).toEqual({ ok: false });
    expect(posted).toEqual([]);
  });
});
