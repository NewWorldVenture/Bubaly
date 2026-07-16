import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-06 SSRF guard. The calendar ICS import fetches a URL the user supplies, which
// is a classic SSRF vector (internal metadata endpoints, loopback, private nets).
// lib/server/public-calendar-fetch.ts implements the defense (rejects loopback /
// private / link-local / metadata, blocks redirects into private networks, caps
// body size — covered by tests/public-calendar-fetch.test.ts). This test pins the
// call SITE so a refactor can't swap in a raw fetch() and silently reintroduce SSRF.
describe('A-06 calendar ICS sync uses the SSRF-guarded fetcher', () => {
  const route = readFileSync('app/api/calendar/sync/route.ts', 'utf8');

  it('imports the guarded public-calendar fetcher', () => {
    expect(route).toMatch(/fetchPublicCalendarText[\s\S]*from '@\/lib\/server\/public-calendar-fetch'/);
  });

  it('fetches the user-supplied ICS URL through the guarded helper', () => {
    expect(route).toContain('fetchPublicCalendarText(');
  });

  it('does not call raw fetch() on a user URL in the sync route', () => {
    // The route must not bypass the guard with a bare fetch(...). (The guarded
    // helper is the only sanctioned network egress for a user-provided ICS URL.)
    const rawFetches = route.match(/[^.\w]fetch\s*\(/g) ?? [];
    expect(rawFetches.length, 'unexpected raw fetch() in calendar sync route').toBe(0);
  });
});
