import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleReconnectRequired,
  getValidAccessToken,
  isGoogleReconnectRequired,
  refreshGoogleToken,
} from '@/lib/google';
import { googleSyncRedirectUri } from '@/lib/sync/providers/google';
import { microsoftRedirectUri } from '@/lib/sync/providers/microsoft';

// TWO defects, both found from a real production OAuth failure.
//
// 1. A DEAD GRANT READ AS A SERVER ERROR. While the OAuth app's publishing
//    status is "Testing", Google expires refresh tokens after SEVEN DAYS. Every
//    connected calendar therefore breaks weekly, and the user was told
//    "Sync failed" — a generic 500 — with no reconnect path anywhere in the UI.
//    lib/google.ts even held the right sentence ("user must reconnect Google")
//    and it never reached the person who needed it.
//
// 2. A BLANK ENV VAR DEFEATING ITS OWN FALLBACK. `.env.example` ships
//    MICROSOFT_SYNC_REDIRECT_URI= empty. The provider helpers used `??`, which
//    treats "" as a real value, so the onboarding leg sent a literal
//    `redirect_uri=` while the dashboard leg — which already used `||` — worked.
//    One flow, two legs, two different URIs; the provider compares them.

const ORIGIN = 'https://www.bubaly.com';

function tokenResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const saved = { g: process.env.GOOGLE_SYNC_REDIRECT_URI, m: process.env.MICROSOFT_SYNC_REDIRECT_URI };

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
});

afterEach(() => {
  if (saved.g === undefined) delete process.env.GOOGLE_SYNC_REDIRECT_URI; else process.env.GOOGLE_SYNC_REDIRECT_URI = saved.g;
  if (saved.m === undefined) delete process.env.MICROSOFT_SYNC_REDIRECT_URI; else process.env.MICROSOFT_SYNC_REDIRECT_URI = saved.m;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a revoked Google grant is a reconnect, not a server error', () => {
  // The distinction the whole fix rests on.
  it('treats 400 invalid_grant as needing reconnection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(400, JSON.stringify({
      error: 'invalid_grant', error_description: 'Token has been expired or revoked.',
    }))));
    await expect(refreshGoogleToken('dead-refresh-token')).rejects.toSatisfy(isGoogleReconnectRequired);
  });

  // An outage must NOT disconnect anybody — the same rule the session code
  // follows for sign-out, applied to a calendar grant.
  it.each([
    ['rate limited', 429, '{"error":"rateLimitExceeded"}'],
    ['server error', 500, 'upstream boom'],
    ['bad gateway', 502, ''],
  ])('does not call a %s a reconnect', async (_case, status, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(status, body)));
    await expect(refreshGoogleToken('live-token')).rejects.toThrow(/token refresh failed/i);
    await refreshGoogleToken('live-token').catch((err) => {
      expect(isGoogleReconnectRequired(err)).toBe(false);
    });
  });

  // A 400 that is NOT invalid_grant is still an ordinary failure.
  it('does not treat every 400 as a dead grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(400, '{"error":"invalid_request"}')));
    await refreshGoogleToken('t').catch((err) => {
      expect(isGoogleReconnectRequired(err)).toBe(false);
    });
  });

  // A stored token with no refresh token can never be renewed: same user-facing
  // situation, so it must classify the same way rather than as a mystery error.
  it('classifies a token with no refresh token as needing reconnection', async () => {
    const expired = { accessToken: 'a', refreshToken: null, expiresAt: Date.now() - 1000 };
    await expect(getValidAccessToken(expired)).rejects.toSatisfy(isGoogleReconnectRequired);
  });

  // A token that is still good must not touch the network at all.
  it('does not refresh a token that is still valid', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const live = { accessToken: 'still-good', refreshToken: 'r', expiresAt: Date.now() + 10 * 60_000 };
    await expect(getValidAccessToken(live)).resolves.toMatchObject({ accessToken: 'still-good' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recognises the error across a serialization boundary', () => {
    expect(isGoogleReconnectRequired(new GoogleReconnectRequired())).toBe(true);
    expect(isGoogleReconnectRequired({ name: 'GoogleReconnectRequired' })).toBe(true);
    expect(isGoogleReconnectRequired(new Error('something else'))).toBe(false);
    expect(isGoogleReconnectRequired(null)).toBe(false);
  });
});

describe('a blank redirect-uri env var falls back instead of being sent', () => {
  // The regression, stated as the value the provider received.
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
  ])('does not send a %s MICROSOFT_SYNC_REDIRECT_URI verbatim', (_case, value) => {
    process.env.MICROSOFT_SYNC_REDIRECT_URI = value;
    expect(microsoftRedirectUri(ORIGIN)).toBe(`${ORIGIN}/api/sync/microsoft/callback`);
  });

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
  ])('does not send a %s GOOGLE_SYNC_REDIRECT_URI verbatim', (_case, value) => {
    process.env.GOOGLE_SYNC_REDIRECT_URI = value;
    expect(googleSyncRedirectUri(ORIGIN)).toBe(`${ORIGIN}/api/sync/google/callback`);
  });

  // A real override must still win — that is the whole reason the var exists.
  it('honours a configured override, trimmed', () => {
    process.env.MICROSOFT_SYNC_REDIRECT_URI = '  https://www.bubaly.com/api/sync/microsoft/callback  ';
    expect(microsoftRedirectUri('https://preview.vercel.app'))
      .toBe('https://www.bubaly.com/api/sync/microsoft/callback');
    process.env.GOOGLE_SYNC_REDIRECT_URI = 'https://www.bubaly.com/api/sync/google/callback';
    expect(googleSyncRedirectUri('https://preview.vercel.app'))
      .toBe('https://www.bubaly.com/api/sync/google/callback');
  });

  // Unset is the ordinary case and must derive from the request.
  it('derives from the request origin when unset', () => {
    delete process.env.MICROSOFT_SYNC_REDIRECT_URI;
    delete process.env.GOOGLE_SYNC_REDIRECT_URI;
    expect(microsoftRedirectUri(ORIGIN)).toBe(`${ORIGIN}/api/sync/microsoft/callback`);
    expect(googleSyncRedirectUri(ORIGIN)).toBe(`${ORIGIN}/api/sync/google/callback`);
  });

  // The two legs of one flow must agree — the provider compares the URIs it is
  // sent. Asserted against the ROUTE SOURCE rather than a hand-written copy of
  // its logic: an earlier draft of this test re-implemented the route with a
  // bare `||`, which silently kept passing the old behaviour after the helpers
  // were fixed. A duplicate of the rule cannot police the rule.
  it.each([
    'app/api/sync/[provider]/auth/route.ts',
    'app/api/sync/[provider]/callback/route.ts',
  ])('builds the same URI in %s as the provider helpers do', (route) => {
    const src = readFileSync(join(__dirname, '..', route), 'utf8');
    expect(src).toContain('_SYNC_REDIRECT_URI`]?.trim()');
    // A bare `??` here would keep "" and send it verbatim — the original defect.
    expect(src).not.toMatch(/_SYNC_REDIRECT_URI`\]\s*\?\?/);
  });
});

// Credentials are PASTED BY HAND out of a text file into a hosting dashboard.
// A trailing newline or space rides along, and every provider answers with an
// error that names nothing: Google `invalid_client`, Entra an unnamed client.
// So every credential is trimmed at its single point of use.
//
// The blank case is worse than cosmetic. `.env.example` ships
// GOOGLE_SYNC_CLIENT_ID= empty, and `??` treats "" as present — so the fallback
// this file's own comment promised ("falls back to the legacy GOOGLE_* pair so
// a single-client setup still works") never fired. isGoogleSyncConfigured()
// returned false and /api/sync/google/auth answered `?error=not_configured`
// with a perfectly good GOOGLE_CLIENT_ID sitting right there.
describe('OAuth credentials survive being pasted', () => {
  const pairs = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_SYNC_CLIENT_ID: process.env.GOOGLE_SYNC_CLIENT_ID,
    GOOGLE_SYNC_CLIENT_SECRET: process.env.GOOGLE_SYNC_CLIENT_SECRET,
    MICROSOFT_SYNC_CLIENT_ID: process.env.MICROSOFT_SYNC_CLIENT_ID,
    MICROSOFT_SYNC_CLIENT_SECRET: process.env.MICROSOFT_SYNC_CLIENT_SECRET,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(pairs)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('strips whitespace a paste dragged along', async () => {
    const { googleClientId, googleClientSecret } = await import('@/lib/google');
    process.env.GOOGLE_CLIENT_ID = '  id.apps.googleusercontent.com\n';
    process.env.GOOGLE_CLIENT_SECRET = 'not-a-real-secret  ';
    expect(googleClientId()).toBe('id.apps.googleusercontent.com');
    expect(googleClientSecret()).toBe('not-a-real-secret');
  });

  // The fallback the old `??` silently disabled.
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
  ])('falls back to the legacy pair when the sync pair is %s', async (_case, value) => {
    const { googleSyncClientId, googleSyncClientSecret, isGoogleSyncConfigured } =
      await import('@/lib/sync/providers/google');
    process.env.GOOGLE_SYNC_CLIENT_ID = value;
    process.env.GOOGLE_SYNC_CLIENT_SECRET = value;
    process.env.GOOGLE_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_CLIENT_SECRET = 'legacy-secret';
    expect(googleSyncClientId()).toBe('legacy-id');
    expect(googleSyncClientSecret()).toBe('legacy-secret');
    // The whole point: the flow reports itself configured instead of answering
    // /api/sync/google/auth with `?error=not_configured`.
    expect(isGoogleSyncConfigured()).toBe(true);
  });

  it('prefers a real dedicated sync client over the legacy pair', async () => {
    const { googleSyncClientId, googleSyncClientSecret } = await import('@/lib/sync/providers/google');
    process.env.GOOGLE_SYNC_CLIENT_ID = ' sync-id ';
    process.env.GOOGLE_SYNC_CLIENT_SECRET = ' sync-secret ';
    process.env.GOOGLE_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_CLIENT_SECRET = 'legacy-secret';
    expect(googleSyncClientId()).toBe('sync-id');
    expect(googleSyncClientSecret()).toBe('sync-secret');
  });

  // Whitespace is TRUTHY, so an untrimmed blank-ish value reads as configured
  // and then fails at the provider under a name nobody can search for.
  it('does not call a whitespace-only Microsoft client configured', async () => {
    const { isMicrosoftSyncConfigured } = await import('@/lib/sync/providers/microsoft');
    process.env.MICROSOFT_SYNC_CLIENT_ID = '   ';
    process.env.MICROSOFT_SYNC_CLIENT_SECRET = '   ';
    expect(isMicrosoftSyncConfigured()).toBe(false);
  });

  it('keeps scopes clean when one scope var is blank', async () => {
    const { googleSyncScopes } = await import('@/lib/sync/providers/google');
    process.env.GOOGLE_SYNC_CALENDAR_SCOPES = 'https://www.googleapis.com/auth/calendar.events';
    process.env.GOOGLE_SYNC_CALENDAR_READONLY_SCOPE = '   ';
    process.env.GOOGLE_SYNC_TASKS_SCOPES = 'https://www.googleapis.com/auth/tasks';
    const scopes = googleSyncScopes();
    expect(scopes).not.toMatch(/ {2,}/);
    expect(scopes.split(' ')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scopes.split(' ')).toContain('https://www.googleapis.com/auth/tasks');
  });

  // A repo-wide guarantee, not a per-site one: a new provider added later must
  // not reintroduce the `??` that broke the fallback and the redirect URIs.
  it('leaves no bare ?? on any provider env var', () => {
    for (const f of ['lib/google.ts', 'lib/sync/providers/google.ts', 'lib/sync/providers/microsoft.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(src, `${f} still has a bare ?? on an env var`).not.toMatch(/process\.env\.[A-Z_]+ \?\?/);
    }
  });
});
