import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Weekend Planner feed fetch boundary', () => {
  it('uses the SSRF-safe bounded public calendar fetcher for family feeds', () => {
    const source = readFileSync('app/api/weekend/discover/route.ts', 'utf8');
    expect(source).toContain("@/lib/server/public-calendar-fetch");
    expect(source).toContain('fetchPublicCalendarText(feed.url)');
    expect(source).not.toContain('fetchWithTimeout(feed.url)');
    expect(source).not.toContain('await res.text()');
  });
});
