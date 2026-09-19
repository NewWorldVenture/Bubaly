import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A server that fetches a URL a user chose is a request the user gets to aim.
// Aimed at `http://169.254.169.254/` it reads cloud instance credentials; aimed
// at a private address it reaches services nothing else can.
//
// This repository defends it properly, and the defence is worth naming because
// it is the part most implementations get wrong: `validatePublicCalendarUrl`
// RESOLVES the hostname and rejects the resolved addresses — link-local,
// loopback, RFC1918, CGNAT, multicast, IPv4-mapped IPv6, `metadata.google
// .internal` — rejects credentials in the URL, and then `fetchPublicText`
// re-validates EVERY REDIRECT with `redirect: 'manual'`, so a public host
// cannot 302 the fetch onto a private one.
//
// Audited call by call when this was written, and all of it was already sound:
//
//   family calendar feeds   -> fetchPublicCalendarText   (guarded)
//   library RSS feeds       -> fetchPublicFeed           (guarded)
//   weekend curated feeds   -> fetchPublicCalendarText   (guarded)
//   Ticketmaster / SeatGeek -> constant host, query only
//   OpenAI, TheMealDB       -> constant host
//   health probe            -> the Supabase URL from env
//
// So this guard exists to keep a property that HOLDS, not to fix one that
// broke. The risk it covers is the premise gap that has produced several
// findings in this audit: the helper is excellent, and nothing stops the next
// route from calling bare `fetch(userUrl)` beside it.
//
// The rule: a server-side `fetch()` whose URL is not a literal constant host
// must live in a file that goes through the guard, or be named below with the
// reason its host cannot be chosen by a user.
const ROOTS = ['app', 'lib'];
const GUARDS = /fetchPublicText|fetchPublicCalendarText|fetchPublicFeed|validatePublicCalendarUrl/;

/**
 * Files whose `fetch()` takes a non-literal URL that a user cannot aim. Each
 * entry is a claim a reviewer can check: the HOST is fixed, only a path or
 * query varies.
 */
const CONSTANT_HOST: Record<string, string> = {
  // Renamed on this branch by C3-S5-04: the file sat among real SSRF guards
  // (public-document-fetch, public-media-fetch, public-calendar-fetch) under a
  // name that read like one, and it only adds a deadline. The exemption still
  // holds — every caller passes a literal provider host, and the one computed
  // caller (app/api/gif/search) builds a constant Giphy URL with an encoded
  // query — but it has to name the file that exists.
  'lib/server/fetch-with-deadline.ts': 'a timeout wrapper; every caller passes a literal provider URL',
  'lib/client-fetch.ts': 'a timeout wrapper for same-origin browser calls',
  'lib/recipes/providers/themealdb.ts': 'BASE is a module constant; only the path varies',
  'lib/blog/posts.ts': 'overrides the Supabase client fetch; the URL is the project URL',
  'lib/health/probe.ts': 'the Supabase URL from env, plus a fixed path',
  'lib/marketing/visitor.ts': 'same-origin relative paths to this app own API',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (extname(p) === '.ts') out.push(p);
  }
  return out;
}

/** `fetch(` calls whose first argument is not a literal `https://constant-host`. */
export function nonLiteralFetches(source: string): number[] {
  const hits: number[] = [];
  for (const m of source.matchAll(/(?<![\w.])fetch\(\s*/g)) {
    const rest = source.slice(m.index + m[0].length, m.index + m[0].length + 90);
    // A quoted absolute URL, or a template whose host is written out, is fixed.
    if (/^['"]https?:\/\//.test(rest)) continue;
    if (/^`https?:\/\/[A-Za-z0-9.\-]+/.test(rest)) continue;
    hits.push(source.slice(0, m.index).split('\n').length);
  }
  return hits;
}

describe('a URL a user chose is only fetched through the SSRF guard', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  it('scans a meaningful number of server files', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('has no server-side fetch of a non-constant URL outside the guard', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (source.slice(0, 60).includes("'use client'")) continue;
      const lines = nonLiteralFetches(source);
      if (lines.length === 0) continue;
      if (GUARDS.test(source)) continue;
      const key = file.split('\\').join('/');
      if (CONSTANT_HOST[key]) continue;
      offenders.push(`${key}:${lines.join(',')} — fetches a non-constant URL without the public-URL guard`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the constant-host list honest — every entry still fetches one', () => {
    // An exemption that outlives its reason is how a guard rots.
    const stale: string[] = [];
    for (const file of Object.keys(CONSTANT_HOST)) {
      if (nonLiteralFetches(readFileSync(file, 'utf8')).length === 0) {
        stale.push(`${file} no longer needs its exemption — remove it`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('the guard still resolves the host and re-checks redirects', () => {
    // The two properties that make it a real defence rather than a string test.
    const src = readFileSync('lib/server/public-calendar-fetch.ts', 'utf8');
    expect(src, 'must resolve the hostname, not just parse it').toMatch(/lookup/);
    expect(src, 'link-local / metadata range must be blocked').toMatch(/0xa9fe0000/);
    expect(src, 'google metadata host must be blocked').toMatch(/metadata\.google\.internal/);
    expect(src, 'redirects must not be followed blindly').toMatch(/redirect: 'manual'/);
    expect(src, 'each redirect target must be re-validated').toMatch(/validatePublicCalendarUrl\(new URL\(location/);
    expect(src, 'credentials in the URL must be refused').toMatch(/url\.username \|\| url\.password/);
  });

  it('recognises the shape it forbids', () => {
    expect(nonLiteralFetches("await fetch(userUrl, { method: 'GET' })")).toEqual([1]);
    expect(nonLiteralFetches('await fetch(`${base}/events`)')).toEqual([1]);
    // A fixed host is not this rule's business.
    expect(nonLiteralFetches("await fetch('https://api.openai.com/v1/x')")).toEqual([]);
    expect(nonLiteralFetches('await fetch(`https://api.seatgeek.com/2/events?${p}`)')).toEqual([]);
  });
});
