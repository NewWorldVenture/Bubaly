import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { listClasses } from '@/lib/services/school';
import type { ServiceScope } from '@/lib/services/types';

function fixture(tz: string, now = '2026-10-12T00:30:00Z') {
  const requests: URL[] = [];
  const rows = ['a', 'b', 'all'].map(week_pattern => ({ id: week_pattern, family_id: 'family', member_id: 'child', subject: week_pattern, week_pattern, day_of_week: 1, time_slot: '09:00' }));
  const db = createClient('https://school-week.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => null,
    global: { fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.origin).toBe('https://school-week.invalid');
      expect(url.pathname).toBe('/rest/v1/school_classes');
      expect(url.searchParams.get('family_id')).toBe('eq.family');
      requests.push(url);
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json', 'content-range': '0-2/3' } });
    } },
  });
  return { requests, scope: { db, familyId: 'family', memberId: 'child', userId: 'user', role: 'parent', actorKind: 'member', tz, now: new Date(now) } as ServiceScope };
}

async function ids(scope: ServiceScope, forDate?: string) {
  const result = await listClasses(scope, { forDate, memberId: 'child', dayOfWeek: 1 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data.map(row => row.id).sort();
}

describe('school A/B weeks use the family calendar date', () => {
  it('keeps Sunday evening in the previous week west of UTC', async () => {
    const f = fixture('America/Los_Angeles');
    expect(await ids(f.scope)).toEqual(['a', 'all']);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].searchParams.get('member_id')).toBe('eq.child');
  });
  it('advances to Monday morning east of UTC before UTC midnight', async () => {
    expect(await ids(fixture('Asia/Tokyo', '2026-10-11T16:00:00Z').scope)).toEqual(['all', 'b']);
  });
  it('uses the family date of an explicit offset timestamp', async () => {
    expect(await ids(fixture('America/Los_Angeles').scope, '2026-10-12T00:30:00+00:00')).toEqual(['a', 'all']);
  });
  it('keeps a date-only Monday as Monday for western families', async () => {
    expect(await ids(fixture('America/Los_Angeles').scope, '2026-10-12')).toEqual(['all', 'b']);
  });
  it('preserves the UTC control', async () => {
    expect(await ids(fixture('UTC').scope)).toEqual(['all', 'b']);
  });
  it.each(['not-a-date', '2026-02-30', '2026-10-12T00:30:00', '2026-02-30T12:00:00Z', '2026-04-31T23:30:00-07:00'])('refuses invalid reference %s before a read', async forDate => {
    const f = fixture('UTC');
    expect(await listClasses(f.scope, { forDate })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.requests).toHaveLength(0);
  });
});
