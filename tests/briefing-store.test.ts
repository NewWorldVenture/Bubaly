// Snapshot containment: no identity or privileged override may restore old
// source data, persist another shared snapshot, or claim that one was delivered.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { buildBrief, type BriefInput } from '@/lib/briefing/build';
import { loadBrief, markDelivered, saveBrief } from '@/lib/briefing/store';
import type { ServiceScope } from '@/lib/services/types';

function blockedDb() {
  const query = vi.fn(() => { throw new Error('Snapshot database access is forbidden during quarantine'); });
  return {
    db: { from: query, rpc: query, auth: { getUser: query } } as unknown as SupabaseClient<Database>,
    query,
  };
}

const NOW = new Date('2026-09-05T13:00:00Z');

function scope(db: SupabaseClient<Database>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW,
  };
}

const BRIEF = buildBrief({
  kind: 'daily', now: NOW,
  events: [{ title: 'Dentist', start: '2026-09-05T14:00:00Z' }],
  snapshot: { bills: [{ name: 'Power', amount: 84, dueDate: '2026-09-03' }] },
  completedRuns: [{ id: 'run-1', state: 'completed', summary: 'Planned the week', progress: { total: 8, completed: 8 }, completed_at: '2026-09-05T11:00:00Z', updated_at: '2026-09-05T11:00:00Z' }],
  activity: [],
} as BriefInput, 'America/New_York');

const callers: [string, Partial<ServiceScope>][] = [
  ['current authenticated member', {}],
  ['another member', { memberId: 'member-2', userId: 'auth-2' }],
  ['another household', { familyId: 'fam-2' }],
  ['missing identity', { memberId: null, userId: null }],
  ['privileged system scope', { actorKind: 'system', role: 'system', memberId: null, userId: null }],
];

describe('saved brief quarantine', () => {
  it.each(callers)('refuses a save without a query or fabricated id for %s', async (_label, changes) => {
    const primary = blockedDb();
    const override = blockedDb();
    const result = await saveBrief({ ...scope(primary.db), ...changes }, BRIEF, { db: override.db });
    expect(result).toMatchObject({ ok: false, code: 'denied', retryable: false });
    expect(result).not.toHaveProperty('data');
    expect(primary.query).not.toHaveBeenCalled();
    expect(override.query).not.toHaveBeenCalled();
  });

  it.each(callers)('misses every daily/evening snapshot without querying for %s', async (_label, changes) => {
    const primary = blockedDb();
    const override = blockedDb();
    for (const kind of ['daily', 'evening'] as const) {
      expect(await loadBrief({ ...scope(primary.db), ...changes }, { asOfDate: '2026-09-05', kind }, { db: override.db }))
        .toEqual({ ok: true, data: null });
    }
    expect(primary.query).not.toHaveBeenCalled();
    expect(override.query).not.toHaveBeenCalled();
  });

  it.each(callers)('never claims delivery or changes a quarantined row for %s', async (_label, changes) => {
    const primary = blockedDb();
    const override = blockedDb();
    expect(await markDelivered({ ...scope(primary.db), ...changes }, 'legacy-shared-brief', { db: override.db, now: NOW }))
      .toEqual({ ok: true, data: false });
    expect(primary.query).not.toHaveBeenCalled();
    expect(override.query).not.toHaveBeenCalled();
  });

  it('does not accept caller-supplied revision hints as permission to reuse a snapshot', async () => {
    const primary = blockedDb();
    const options = { db: primary.db, permissionRevision: 'guessed', allowReuse: true };
    expect(await loadBrief(scope(primary.db), { asOfDate: '2026-09-05', kind: 'daily' }, options))
      .toEqual({ ok: true, data: null });
    expect(primary.query).not.toHaveBeenCalled();
  });
});
