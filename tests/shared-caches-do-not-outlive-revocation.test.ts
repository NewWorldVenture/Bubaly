// A response in a shared cache is served without touching this application:
// no session, no RLS, no token lookup, no `feed_enabled` check. For the window
// the header names, the cache IS the authorization — so the header has to be
// shorter than the time it takes to take access away.
//
// `/api/sync/feeds/<token>` is the one route where that mattered. It serves a
// family's calendar — event titles, descriptions, locations — to anyone holding
// an unguessable token, which is the design: Apple Calendar and Outlook cannot
// log in. `lib/sync/feed-token.ts` calls the token "revocable (rotate the
// column to revoke)" and the route repeats it. It also sent `s-maxage=900`, so
// Vercel's edge and any proxy in between kept serving that calendar for fifteen
// minutes after the revocation — a family that rotates the token because the
// URL leaked is told it is gone while it is still being served.
//
// `max-age` is a different question and is left alone: that is the subscriber's
// own browser or calendar client, and they are the one who held the token.
// `s-maxage` is everyone else's cache.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const API = join(ROOT, 'app/api');

/** Longest a shared cache may hold a response derived from one family's data. */
const MAX_SHARED_SECONDS = 60;

function routes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routes(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

type Header = { file: string; value: string; sMaxAge: number | null };

const sharedCacheHeaders: Header[] = routes(API).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  // Both spellings. A route that lifts its header into a module constant —
  // `const CACHE_CONTROL = 'public, …'` — is still sending that header, and a
  // sweep that only reads the literal at the call site would report it clean.
  // `app/api/blog/search-index/route.ts` is written that way, and it was the
  // stale-exemption case below that caught the gap rather than any reading.
  const values = [
    ...[...text.matchAll(/'Cache-Control':\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...text.matchAll(/^const\s+[A-Z_]*CACHE[A-Z_]*\s*=\s*'([^']+)'/gm)].map((m) => m[1]),
  ];
  return values
    .filter((value) => /\bpublic\b/.test(value) && /s-maxage=/.test(value))
    .map((value) => ({
      file: relative(ROOT, file),
      value,
      sMaxAge: Number(/s-maxage=(\d+)/.exec(value)?.[1] ?? NaN) || null,
    }));
});

/**
 * Routes whose body is the same for every visitor on earth, so a shared cache
 * holds nothing that belongs to anyone. A reason has to say why, in terms a
 * reviewer can check against the handler.
 */
const SAME_FOR_EVERYONE: Record<string, string> = {
  'app/api/services/descriptions/route.ts': 'Returns the super-admin service-description overrides — one global row set, identical for every visitor, with no request input of any kind (the handler takes no arguments).',
  'app/api/blog/search-index/route.ts': 'Returns the published blog index through fetchAllPublishedRows + publicRows; every visitor, signed in or not, gets the same published posts.',
};

describe('a shared cache is not a longer-lived copy of the authorization', () => {
  it('finds the cache headers it is supposed to be checking', () => {
    // If this ever reads zero, the sweep has stopped matching the codebase and
    // every case below passes for the wrong reason.
    expect(sharedCacheHeaders.length).toBeGreaterThan(0);
  });

  it('caps how long anyone else may hold a response that is not the same for everyone', () => {
    const offenders = sharedCacheHeaders
      .filter((h) => !(h.file in SAME_FOR_EVERYONE))
      .filter((h) => h.sMaxAge === null || h.sMaxAge > MAX_SHARED_SECONDS)
      .map((h) => `${h.file} sends "${h.value}" — a shared cache may serve it for ${h.sMaxAge ?? 'an unbounded time'}s after access is revoked`);
    expect(offenders).toEqual([]);
  });

  it('states a checkable reason for every route exempted as public content', () => {
    const thin = Object.entries(SAME_FOR_EVERYONE)
      .filter(([, reason]) => reason.trim().length <= 40)
      .map(([file]) => file);
    expect(thin).toEqual([]);
  });

  it('keeps no exemption for a route that no longer sets a shared cache header', () => {
    const stale = Object.keys(SAME_FOR_EVERYONE)
      .filter((file) => !sharedCacheHeaders.some((h) => h.file === file));
    expect(stale).toEqual([]);
  });

  // The route the rule was written for, named — so losing it fails with the
  // feed rather than with a count.
  it('lets the calendar feed keep its own subscriber cache but not everyone else’s', () => {
    const feed = sharedCacheHeaders.find((h) => h.file.includes('sync/feeds'));
    expect(feed, 'the ICS feed no longer sets a cache header').toBeTruthy();
    expect(feed!.sMaxAge).toBeLessThanOrEqual(MAX_SHARED_SECONDS);
    // The subscriber's own copy is not the shared one and is deliberately long.
    expect(/max-age=(\d+)/.exec(feed!.value)?.[1]).toBe('900');
  });
});
