import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_API_ORIGINS, buildContentSecurityPolicy, parseContentSecurityPolicy } from '@/lib/security/csp.mjs';

// Every third-party API the browser talks to must be allowed by the CSP's
// connect-src, or the module silently breaks in production. This test walks the
// libraries that client components import for network calls and checks each
// https:// origin they fetch against CLIENT_API_ORIGINS, and also scans every
// 'use client' component for a direct external fetch.

/** Libraries known to be imported by client components and to call fetch(). */
const CLIENT_FETCHING_LIBS = ['lib/weather/open-meteo.ts', 'lib/trips/routing.ts'];

const IGNORED_ORIGINS = new Set(['https://www.bubaly.com', 'https://bubaly.com']);

function origins(source: string): string[] {
  return [...new Set([...source.matchAll(/https:\/\/[a-zA-Z0-9.-]+\.[a-z]{2,}/g)].map((m) => m[0]))];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const csp = parseContentSecurityPolicy(buildContentSecurityPolicy({ supabaseUrl: 'https://abc.supabase.co' }));

describe('CSP connect-src covers every browser-side API', () => {
  it('allows each origin fetched by the client-side libraries', () => {
    for (const file of CLIENT_FETCHING_LIBS) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} should still call fetch()`).toMatch(/fetch\(/);
      for (const origin of origins(src)) {
        if (IGNORED_ORIGINS.has(origin)) continue;
        expect(CLIENT_API_ORIGINS, `${origin} (used by ${file}) is missing from CLIENT_API_ORIGINS`).toContain(origin);
        expect(csp['connect-src']).toContain(origin);
      }
    }
  });

  it('no client component fetches a third-party origin directly', () => {
    const offenders: string[] = [];
    for (const file of walk('components')) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes("'use client'")) continue;
      for (const m of src.matchAll(/fetch\((['"`])(https:\/\/[^'"`)]+)/g)) {
        const origin = new URL(m[2]).origin;
        if (!IGNORED_ORIGINS.has(origin) && !CLIENT_API_ORIGINS.includes(origin)) offenders.push(`${file}: ${origin}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
