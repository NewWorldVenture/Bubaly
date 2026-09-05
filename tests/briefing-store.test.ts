// Filing and delivering a brief (0258).
//
// Two promises: one row per family per day per kind, so a cron that runs twice
// does not leave two briefs; and the family is told once, so two crons racing
// cannot both send. The second is a compare-and-set, and the test that matters
// is the loser getting `false`.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import { buildBrief, type BriefInput } from '@/lib/briefing/build';
import { loadBrief, markDelivered, saveBrief } from '@/lib/briefing/store';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: string; filters: Record<string, unknown>; payload?: unknown; conflict?: string };

function makeDb(reply: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, limit: chain,
      eq: (c: string, v: unknown) => { call.filters[c] = v; return b; },
      is: (c: string, v: unknown) => { call.filters[`is:${c}`] = v; return b; },
      upsert: (payload: unknown, opts?: { onConflict?: string }) => { call.kind = 'upsert'; call.payload = payload; call.conflict = opts?.onConflict; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => Promise.resolve(reply(call)),
      maybeSingle: () => Promise.resolve(reply(call)),
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(reply(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
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

describe('saveBrief', () => {
  it('upserts on the day-and-kind key, under the family', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'brief-1' }, error: null }));
    const res = await saveBrief(scope(db), BRIEF);
    expect(res).toEqual({ ok: true, data: { id: 'brief-1' } });
    const write = calls.find((c) => c.kind === 'upsert');
    expect(write?.conflict).toBe('family_id,as_of_date,kind');
    expect(write?.payload).toMatchObject({ family_id: 'fam-1', as_of_date: '2026-09-05', kind: 'daily' });
  });

  it('reports a write failure instead of pretending the brief was filed', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'permission denied' } }));
    const res = await saveBrief(scope(db), BRIEF);
    expect(res).toMatchObject({ ok: false, code: 'db', retryable: true });
  });
});

describe('loadBrief', () => {
  it('reads the family’s brief for that day and kind', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'brief-1', brief: BRIEF, delivered_at: null }, error: null }));
    const res = await loadBrief(scope(db), { asOfDate: '2026-09-05', kind: 'daily' });
    expect(res.ok && res.data?.id).toBe('brief-1');
    expect(res.ok && res.data?.brief.headline).toBe(BRIEF.headline);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', as_of_date: '2026-09-05', kind: 'daily' });
  });

  it('treats a row from an older shape as "no brief yet" rather than crashing the page', async () => {
    const { db } = makeDb(() => ({ data: { id: 'brief-1', brief: { headline: 'from an older version' }, delivered_at: null }, error: null }));
    const res = await loadBrief(scope(db), { asOfDate: '2026-09-05', kind: 'daily' });
    expect(res).toEqual({ ok: true, data: null });
  });

  it('answers null when there is nothing yet', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    expect(await loadBrief(scope(db), { asOfDate: '2026-09-05', kind: 'evening' })).toEqual({ ok: true, data: null });
  });
});

describe('markDelivered', () => {
  it('tells the family once: the second caller is told it already went', async () => {
    const delivered = { value: false };
    const { db, calls } = makeDb((call) => {
      if (call.kind !== 'update') return { data: null, error: null };
      if (delivered.value) return { data: [], error: null };
      delivered.value = true;
      return { data: [{ id: 'brief-1' }], error: null };
    });

    expect(await markDelivered(scope(db), 'brief-1')).toEqual({ ok: true, data: true });
    expect(await markDelivered(scope(db), 'brief-1')).toEqual({ ok: true, data: false });
    // The guard is in the query, not in application memory.
    expect(calls.find((c) => c.kind === 'update')?.filters).toMatchObject({ id: 'brief-1', family_id: 'fam-1', 'is:delivered_at': null });
  });

  it('surfaces a failure rather than reporting a delivery that did not happen', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    expect(await markDelivered(scope(db), 'brief-1')).toMatchObject({ ok: false, code: 'db' });
  });
});
