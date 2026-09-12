import { describe, it, expect } from 'vitest';
import {
  checkOAuthConfig,
  checkCredentials,
  checkRedirectUris,
  checkScopes,
  checkAppUrl,
  hasEdgeWhitespace,
  isBlankish,
  summarize,
  REDIRECT_URIS,
} from '../scripts/lib/oauth-config-check.mjs';

type Finding = { level: string; key: string; message: string };

/** A configuration that should raise nothing at error level. */
const GOOD: Record<string, string> = {
  NEXT_PUBLIC_APP_URL: 'https://www.bubaly.com',
  GOOGLE_CLIENT_ID: '000000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'not-a-real-secret',
  GOOGLE_SYNC_CLIENT_ID: '000000000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.apps.googleusercontent.com',
  GOOGLE_SYNC_CLIENT_SECRET: 'not-a-real-secret-either',
  GOOGLE_SYNC_REDIRECT_URI: 'https://www.bubaly.com/api/sync/google/callback',
  MICROSOFT_SYNC_REDIRECT_URI: 'https://www.bubaly.com/api/sync/microsoft/callback',
  GOOGLE_SYNC_CALENDAR_SCOPES: 'https://www.googleapis.com/auth/calendar.events',
  GOOGLE_SYNC_CALENDAR_READONLY_SCOPE: 'https://www.googleapis.com/auth/calendar.readonly',
  GOOGLE_SYNC_TASKS_SCOPES: 'https://www.googleapis.com/auth/tasks',
};

const errorsFor = (env: Record<string, string | undefined>): Finding[] =>
  summarize(checkOAuthConfig(env)).errors;
const keysOf = (findings: Finding[]) => findings.map((f) => f.key);

describe('oauth config preflight', () => {
  it('passes a correctly configured production environment', () => {
    expect(errorsFor(GOOD)).toEqual([]);
  });

  // The four production failures this check exists for. Each one reached a
  // provider as an error that named nothing; each is named here.

  it('catches the blank-but-present value that defeats a `??` fallback', () => {
    // `.env.example` shipped `GOOGLE_SYNC_CLIENT_ID=` and `??` read "" as a
    // real value, so /api/sync/google/auth answered ?error=not_configured with
    // a perfectly good GOOGLE_CLIENT_ID available.
    expect(isBlankish('')).toBe(true);
    expect(isBlankish('   ')).toBe(true);
    expect(isBlankish(undefined)).toBe(false);
    const errs = errorsFor({ ...GOOD, GOOGLE_SYNC_CLIENT_ID: '' });
    expect(keysOf(errs)).toContain('GOOGLE_SYNC_CLIENT_ID');
    expect(errs.find((f) => f.key === 'GOOGLE_SYNC_CLIENT_ID')!.message).toMatch(/blank/);
  });

  it('distinguishes blank from absent — absent is allowed, blank is not', () => {
    const absent = { ...GOOD };
    delete absent.GOOGLE_SYNC_CLIENT_ID;
    delete absent.GOOGLE_SYNC_CLIENT_SECRET;
    expect(errorsFor(absent)).toEqual([]);
    expect(errorsFor({ ...GOOD, GOOGLE_SYNC_CLIENT_ID: '', GOOGLE_SYNC_CLIENT_SECRET: '' }).length).toBeGreaterThan(0);
  });

  it('catches the trailing newline a dashboard paste carries', () => {
    expect(hasEdgeWhitespace('secret\n')).toBe(true);
    expect(hasEdgeWhitespace(' secret')).toBe(true);
    expect(hasEdgeWhitespace('secret')).toBe(false);
    // A value that is only whitespace is reported as blank, not as whitespace —
    // one finding per value, and "blank" is the more actionable of the two.
    expect(hasEdgeWhitespace('   ')).toBe(false);
    expect(keysOf(errorsFor({ ...GOOD, GOOGLE_CLIENT_SECRET: 'not-a-real-secret\n' })))
      .toContain('GOOGLE_CLIENT_SECRET');
  });

  it('catches a redirect URI whose path does not match its route', () => {
    const errs = errorsFor({ ...GOOD, GOOGLE_SYNC_REDIRECT_URI: 'https://www.bubaly.com/api/google/calendar/callback' });
    expect(errs.find((f) => f.key === 'GOOGLE_SYNC_REDIRECT_URI')!.message)
      .toMatch(/\/api\/sync\/google\/callback/);
  });

  it('catches a redirect URI that is not absolute', () => {
    expect(keysOf(errorsFor({ ...GOOD, GOOGLE_SYNC_REDIRECT_URI: '/api/sync/google/callback' })))
      .toContain('GOOGLE_SYNC_REDIRECT_URI');
  });

  it('rejects a non-https redirect URI but allows localhost', () => {
    expect(keysOf(errorsFor({ ...GOOD, GOOGLE_SYNC_REDIRECT_URI: 'http://www.bubaly.com/api/sync/google/callback' })))
      .toContain('GOOGLE_SYNC_REDIRECT_URI');
    expect(errorsFor({ ...GOOD, GOOGLE_SYNC_REDIRECT_URI: 'http://localhost:3000/api/sync/google/callback' }))
      .toEqual([]);
  });

  it('rejects a redirect URI carrying a query string', () => {
    expect(keysOf(errorsFor({ ...GOOD, GOOGLE_SYNC_REDIRECT_URI: 'https://www.bubaly.com/api/sync/google/callback?x=1' })))
      .toContain('GOOGLE_SYNC_REDIRECT_URI');
  });

  it('warns when a redirect URI host differs from the app URL host', () => {
    const { warnings } = summarize(checkOAuthConfig({
      ...GOOD,
      GOOGLE_SYNC_REDIRECT_URI: 'https://bubaly.vercel.app/api/sync/google/callback',
    }));
    expect(keysOf(warnings)).toContain('GOOGLE_SYNC_REDIRECT_URI');
  });

  it('names the missing half of a credential pair', () => {
    const half = { ...GOOD };
    delete half.GOOGLE_SYNC_CLIENT_SECRET;
    const errs = errorsFor(half);
    expect(keysOf(errs)).toContain('GOOGLE_SYNC_CLIENT_SECRET');
    expect(errs.find((f) => f.key === 'GOOGLE_SYNC_CLIENT_SECRET')!.message).toMatch(/invalid_client/);
  });

  it('catches an id and secret pasted into each other’s slot', () => {
    const errs = errorsFor({ ...GOOD, GOOGLE_CLIENT_SECRET: '123-abc.apps.googleusercontent.com' });
    expect(errs.find((f) => f.key === 'GOOGLE_CLIENT_SECRET')!.message).toMatch(/swapped/);
  });

  it('warns about a Google client id that is not shaped like one', () => {
    const { warnings } = summarize(checkCredentials({ ...GOOD, GOOGLE_CLIENT_ID: 'nope' }));
    expect(keysOf(warnings)).toContain('GOOGLE_CLIENT_ID');
  });

  it('rejects a scope that is not a Google scope URL', () => {
    expect(keysOf(checkScopes({ GOOGLE_SYNC_TASKS_SCOPES: 'tasks' }))).toContain('GOOGLE_SYNC_TASKS_SCOPES');
    expect(checkScopes({ GOOGLE_SYNC_TASKS_SCOPES: 'https://www.googleapis.com/auth/tasks' })).toEqual([]);
  });

  it('rejects an app URL that is not absolute, since it is interpolated verbatim', () => {
    // `${process.env.NEXT_PUBLIC_APP_URL}/api/...` with an unset variable is
    // what produced the literal "undefined/api/google/calendar/callback" and
    // Google's Error 400: invalid_request.
    expect(keysOf(checkAppUrl({ NEXT_PUBLIC_APP_URL: 'www.bubaly.com' }))).toContain('NEXT_PUBLIC_APP_URL');
    expect(checkAppUrl({ NEXT_PUBLIC_APP_URL: 'https://www.bubaly.com' })).toEqual([]);
  });

  it('notes, rather than fails, an unset redirect URI', () => {
    const bare = { ...GOOD };
    delete bare.GOOGLE_SYNC_REDIRECT_URI;
    const { errors, notes } = summarize(checkOAuthConfig(bare));
    expect(errors).toEqual([]);
    expect(keysOf(notes)).toContain('GOOGLE_SYNC_REDIRECT_URI');
  });
});

describe('the checked redirect URIs match the routes that exist', () => {
  // A preflight that validates a path the app does not serve is worse than no
  // preflight: it certifies a URI the callback will 404 on. Checked against the
  // filesystem so a route rename cannot leave this table quietly stale.
  //
  // Resolution has to mirror Next.js's own: /api/sync/google/callback is served
  // by the STATIC app/api/sync/google/callback, which shadows the dynamic
  // app/api/sync/[provider]/callback that serves /api/sync/microsoft/callback.
  // A checker that only looked for the literal path would call the Microsoft
  // callback missing; one that only looked for the dynamic segment would miss
  // that Google has its own implementation.
  const resolveRoute = async (path: string): Promise<string | null> => {
    const { existsSync, readdirSync } = await import('node:fs');
    const segments = path.replace(/^\//, '').split('/');
    let dir = 'app';
    for (const segment of segments) {
      if (existsSync(`${dir}/${segment}`)) {
        dir = `${dir}/${segment}`;
        continue;
      }
      const dynamic = readdirSync(dir, { withFileTypes: true })
        .find((e) => e.isDirectory() && /^\[.+\]$/.test(e.name));
      if (!dynamic) return null;
      dir = `${dir}/${dynamic.name}`;
    }
    return existsSync(`${dir}/route.ts`) ? `${dir}/route.ts` : null;
  };

  it.each(REDIRECT_URIS.map((r: { key: string; path: string }) => [r.key, r.path]))(
    '%s → %s is a real route',
    async (_key: string, path: string) => {
      expect(await resolveRoute(path)).not.toBeNull();
    },
  );

  it('fails for a path no route serves', async () => {
    // Proves the resolver above can say no — a check that always passes is not
    // a check. `[provider]` must not swallow an unrelated first segment.
    expect(await resolveRoute('/api/nope/callback')).toBeNull();
  });
});
