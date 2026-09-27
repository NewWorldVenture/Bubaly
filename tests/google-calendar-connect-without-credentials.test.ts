import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Found by the API sweep (scripts/api-audit): on a server without Google
// credentials, "Connect Google" on /dashboard/calendar is a plain link to
// /api/google/calendar/auth, and that route let getGoogleOAuthUrl's
// "GOOGLE_CLIENT_ID is not set" error escape. The parent who clicked it got a
// blank 500 page and no way back to their calendar.
//
// The Outlook link beside it already does the right thing for the same state
// (/api/sync/[provider]/auth redirects to its setup page). This route now does
// the same: back to the calendar, which says the connection isn't set up.

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn(async () => ({ user: { id: 'u' } })) }));

const ORIGIN = 'https://www.bubaly.com';
const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'client-fixture.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'secret-fixture';
});
afterEach(() => {
  restore('GOOGLE_CLIENT_ID', saved.id);
  restore('GOOGLE_CLIENT_SECRET', saved.secret);
  vi.resetModules();
});

async function start() {
  const { GET } = await import('@/app/api/google/calendar/auth/route');
  return GET(new NextRequest(`${ORIGIN}/api/google/calendar/auth`));
}

describe('connecting Google Calendar on a server without Google credentials', () => {
  it.each([
    ['no client id', 'GOOGLE_CLIENT_ID'],
    ['no client secret', 'GOOGLE_CLIENT_SECRET'],
  ])('returns the parent to the calendar when there is %s', async (_case, missing) => {
    delete process.env[missing];
    const res = await start();
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe('/dashboard/calendar');
    expect(to.searchParams.get('gcal')).toBe('not_configured');
    // No state cookie for a consent request that was never made.
    expect(res.cookies.get('gcal_oauth_state')).toBeUndefined();
  });

  it('still sends a configured server to Google with a single-use state', async () => {
    const res = await start();
    const to = new URL(res.headers.get('location')!);
    expect(to.host).toBe('accounts.google.com');
    expect(to.searchParams.get('state')).toBe(res.cookies.get('gcal_oauth_state')?.value);
  });

  it('tells the parent on the calendar page, in their language', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('components/modules/calendar-module.tsx', 'utf8');
    expect(src).toMatch(/params\.get\('gcal'\) === 'not_configured'\)\s*\{\s*toastError\(tr\('calendarModule\.googleCalendarNotConfigured'\)\)/);
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['calendarModule.googleCalendarNotConfigured'], locale).toBeTruthy();
    }
  });
});
