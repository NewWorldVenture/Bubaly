// A reminder time given with no zone is the FAMILY's time.
//
// The school desk proposes `remind_at: "${date}T09:00:00"` for a permission
// slip or a fee, and the school/sports templates pass `localTime(dayKey, 7, 0)`
// for the morning reminder. `createReminder` resolved these with `Date.parse`
// — the HOST's clock, UTC on Vercel — so the 9am reminder fired at 2am in Los
// Angeles and 11am in Berlin, while the sibling calendar service read the same
// strings in `scope.tz`.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createReminder } from '@/lib/services/reminders';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

function scopeIn(tz: string): { scope: ServiceScope; rows: () => Record<string, unknown>[] } {
  const db = createInMemorySupabase({ defaults: { family_reminders: { status: 'active', snoozed_until: null, completed_at: null } } });
  return {
    scope: { db: db as unknown as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz },
    rows: () => db.table('family_reminders') as Record<string, unknown>[],
  };
}

async function remindAtStored(tz: string, remindAt: string): Promise<string> {
  const { scope, rows } = scopeIn(tz);
  const res = await createReminder(scope, { title: 'Permission slip', remindAt, kind: 'school' });
  expect(res.ok, `${tz} ${remindAt}`).toBe(true);
  return new Date(String(rows()[0].remind_at)).toISOString();
}

describe('createReminder reads a zone-less remind_at on the family clock', () => {
  it.each([
    ['America/Los_Angeles', '2026-09-14T09:00:00', '2026-09-14T16:00:00.000Z'],
    ['Europe/Berlin', '2026-09-14T09:00:00', '2026-09-14T07:00:00.000Z'],
    ['Asia/Tokyo', '2026-09-14T07:00', '2026-09-13T22:00:00.000Z'],
    ['UTC', '2026-09-14T09:00:00', '2026-09-14T09:00:00.000Z'],
  ])('%s: %s fires at %s', async (tz, remindAt, instant) => {
    expect(await remindAtStored(tz, remindAt)).toBe(instant);
  });

  it('a bare date is the family\'s midnight of that day', async () => {
    expect(await remindAtStored('America/Los_Angeles', '2026-09-14')).toBe('2026-09-14T07:00:00.000Z');
  });

  it('an offset or Z is kept exactly as written', async () => {
    expect(await remindAtStored('America/Los_Angeles', '2026-09-14T09:00:00Z')).toBe('2026-09-14T09:00:00.000Z');
    expect(await remindAtStored('Asia/Tokyo', '2026-09-14T09:00:00-04:00')).toBe('2026-09-14T13:00:00.000Z');
  });

  it('refuses a clock that does not exist rather than rolling it', async () => {
    const { scope, rows } = scopeIn('America/Los_Angeles');
    expect(await createReminder(scope, { title: 'x', remindAt: '2026-09-14T25:00:00' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await createReminder(scope, { title: 'x', remindAt: 'tuesday' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(rows()).toHaveLength(0);
  });
});
