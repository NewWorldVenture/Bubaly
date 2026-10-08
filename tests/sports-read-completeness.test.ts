import { describe, expect, it } from 'vitest';
import { listPracticesBetween } from '@/lib/services/sports';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const bounds = { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' };
const event = (id: string, extra = {}) => ({ id, family_id: 'family', member_id: 'member', event_type: 'practice',
  starts_at: '2026-10-28T21:00:00.000Z', ends_at: '2026-10-28T22:00:00.000Z', recurrence: 'weekly', recurrence_until: null, ...extra });
const scope = (rows: ReturnType<typeof event>[], maxRows?: number): ServiceScope => {
  const db = createInMemorySupabase({ maxRows });
  db.seed('sports_events', rows);
  return { db: db as unknown as ServiceScope['db'], familyId: 'family', userId: 'user', memberId: 'member', role: 'parent', actorKind: 'member', tz: 'America/New_York' };
};

describe('sports reads preserve complete nearest occurrences', () => {
  it('finds weekly practice entered six years ago on the family clock', async () => {
    const result = await listPracticesBetween(scope([event('old', { starts_at: '2020-10-28T21:00:00.000Z', ends_at: '2020-10-28T22:00:00.000Z' })]), bounds);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map(row => [row.id, row.starts_at, row.ends_at])).toEqual([['old', '2026-11-04T22:00:00.000Z', '2026-11-04T23:00:00.000Z']]);
  });

  it('reads every recurring master across a lower server cap', async () => {
    const result = await listPracticesBetween(scope(['a', 'b', 'c'].map(id => event(id)), 2), bounds);
    expect(result.ok && result.data.map(row => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('reads and sorts the requested nearest singles across capped pages', async () => {
    const rows = [7, 2, 6, 1, 5, 3, 4].map(day => event(String(day), { recurrence: 'none', starts_at: `2026-11-0${day}T12:00:00.000Z`, ends_at: null }));
    const result = await listPracticesBetween(scope(rows, 2), { ...bounds, limit: 5 });
    expect(result.ok && result.data.map(row => row.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps family/member/type filters on subsequent pages', async () => {
    const rows = [event('a'), event('b'), event('c'), event('foreign', { family_id: 'other' }), event('sibling', { member_id: 'other' }), event('game', { event_type: 'game' })];
    const result = await listPracticesBetween(scope(rows, 1), { ...bounds, memberId: 'member', eventType: 'practice' });
    expect(result.ok && result.data.map(row => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('excludes expired series before enforcing the master limit', async () => {
    const rows = Array.from({ length: 2001 }, (_, n) => event(`expired-${n}`, { recurrence_until: '2026-10-31T00:00:00.000Z' }));
    const result = await listPracticesBetween(scope([...rows, event('active')], 2), bounds);
    expect(result.ok && result.data.map(row => row.id)).toEqual(['active']);
  });

  it('refuses too many live masters instead of returning the first page', async () => {
    const result = await listPracticesBetween(scope(Array.from({ length: 2001 }, (_, n) => event(String(n))), 2), bounds);
    expect(result).toMatchObject({ ok: false, code: 'db' });
  });

  it('refuses an expansion prefix instead of claiming a complete schedule', async () => {
    const result = await listPracticesBetween(scope([event('long', { recurrence: 'daily' })]), { from: '2026-10-28T00:00:00Z', to: '2028-11-01T00:00:00Z' });
    expect(result).toMatchObject({ ok: false, code: 'db' });
  });

  it.each([NaN, Infinity, 0, -1, 1.5])('rejects invalid display limit %s', async limit => {
    const result = await listPracticesBetween(scope([]), { ...bounds, limit });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
