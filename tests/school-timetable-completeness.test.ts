import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { listClasses } from '@/lib/services/school';
import type { ServiceScope } from '@/lib/services/types';

function fixture(total: number, serverCap = 100, includeCount = true) {
  const requests: URL[] = [];
  const db = createClient('https://school-rows.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => null,
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.origin).toBe('https://school-rows.invalid');
      expect(url.pathname).toBe('/rest/v1/school_classes');
      expect(url.searchParams.get('family_id')).toBe('eq.family');
      expect(url.searchParams.get('member_id')).toBe('eq.child');
      requests.push(url);
      const start = Number(url.searchParams.get('offset') ?? 0);
      const take = Math.min(serverCap, Number(url.searchParams.get('limit') ?? total), total - start);
      const rows = Array.from({ length: Math.max(take, 0) }, (_, i) => ({ id: String(start + i).padStart(4, '0'), family_id: 'family', member_id: 'child', subject: 'Class', week_pattern: 'all', day_of_week: 1, time_slot: '09:00' }));
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json', ...(includeCount ? { 'content-range': `${start}-${start + rows.length - 1}/${total}` } : {}) } });
    } },
  });
  return { requests, scope: { db, familyId: 'family', memberId: 'child', userId: 'user', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-10-12T12:00:00Z') } as ServiceScope };
}

describe('school timetable completeness', () => {
  it('pages past a lower server cap and retains family/member scope', async () => {
    const f = fixture(601);
    const result = await listClasses(f.scope, { memberId: 'child' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toHaveLength(601);
    expect(result.data.at(-1)?.id).toBe('0600');
    expect(f.requests).toHaveLength(7);
    expect(f.requests.every(url => url.searchParams.get('order')?.includes('id.asc'))).toBe(true);
  });
  it('refuses a timetable beyond the bounded complete-read ceiling', async () => {
    const f = fixture(2001);
    expect(await listClasses(f.scope, { memberId: 'child' })).toMatchObject({ ok: false, code: 'db' });
    expect(f.requests).toHaveLength(1);
  });
  it('refuses an uncounted capped response rather than claiming a complete timetable', async () => {
    const f = fixture(601, 100, false);
    expect(await listClasses(f.scope, { memberId: 'child' })).toMatchObject({ ok: false, code: 'db' });
  });
  it('preserves a small complete timetable', async () => {
    const f = fixture(2);
    const result = await listClasses(f.scope, { memberId: 'child' });
    expect(result.ok && result.data.length).toBe(2);
    expect(f.requests).toHaveLength(1);
  });
});
