// Prep-plan generation upserted a HARDCODED `status: 'active'` over every row
// it touched (lib/planning/prep-server.ts). `generatePrepPlans` is pure over
// the current signals and never reads the table, so a plan whose signal is
// still in the horizon is re-emitted on every single run — and with `status`
// in the payload and no `ignoreDuplicates`, PostgREST's `ON CONFLICT DO UPDATE
// SET` wrote 'active' back over it.
//
// The value it overwrote is the family's own decision. The X on
// /dashboard/prep-plans (components/modules/planning-module.tsx) writes
// `status: 'dismissed'`, the list reads `.eq('status', 'active')`, and there is
// no un-dismiss anywhere, so that column is the ONLY way a family can retire a
// plan they do not want. Generation re-activated it: instantly if anyone
// pressed "Generate plans" on that same screen, and unattended at 04:00 UTC
// when app/api/cron/model-refresh/route.ts sweeps every family on the service
// client.
//
// The guard is the one the sibling generator already has —
// lib/intelligence/hard-signals-server.ts reads the existing rows, drops the
// ones the family already decided, and omits `status` from its payload so a
// decision landing mid-flight is not reset either. And that read FAILS CLOSED:
// PostgREST answers a refusal with `{ data: null, error }`, so a dropped error
// reads as "this family has dismissed nothing" and the very next write
// un-dismisses everything.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const TZ = 'UTC';
/** The family's today is 2026-09-21 at both instants; the second is the cron's sweep. */
const GENERATED_AT = new Date('2026-09-21T12:00:00Z');
const CRON_SWEEP_AT = new Date('2026-09-22T04:00:00Z');

/**
 * A household with exactly two signals in the horizon: Mia's birthday, eleven
 * months out (urgency 'later' — the plan a parent calls noise), and a trip two
 * weeks out that nobody dismissed and that must keep being refreshed.
 */
function household() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: {
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
    // 0131_prep_plans.sql: `status text not null default 'active'`. The default
    // lives in the schema, which is the whole point — a new row gets 'active'
    // from the column, not from a value the generator writes over old rows.
    defaults: { prep_plans: { status: 'active' } },
  });
  db.seed('family_members', [{ id: 'm-mia', family_id: 'f1', display_name: 'Mia', birthday: '2015-08-15' }]);
  db.seed('vacations', [{ id: 'v-beach', family_id: 'f1', title: 'Beach Trip', start_date: '2026-10-05' }]);
  return db;
}

const planFor = (db: InMemorySupabase, signalId: string) =>
  db.table('prep_plans').find((row) => row.signal_id === signalId);

describe('a plan the family dismissed', () => {
  it('is still dismissed after the cron regenerates the family the next morning', async () => {
    const db = household();

    const first = await runPrepGeneration(db, 'f1', 'parent-1', TZ, GENERATED_AT);
    expect(first.ok).toBe(true);
    expect(first.plans).toBe(2);
    const birthday = planFor(db, 'm-mia');
    expect(birthday?.title).toBe("Plan: Mia's Birthday");
    expect(birthday?.status).toBe('active');

    // The X on the card, exactly as planning-module.tsx writes it.
    const { error } = await db.from('prep_plans').update({ status: 'dismissed' }).eq('id', birthday!.id);
    expect(error).toBeNull();

    // 04:00 UTC: model-refresh sweeps the family on the service client. Nobody
    // in the household touched anything.
    const second = await runPrepGeneration(db, 'f1', null, TZ, CRON_SWEEP_AT);
    expect(second.ok).toBe(true);

    // The card does NOT come back.
    expect(planFor(db, 'm-mia')?.status).toBe('dismissed');
    // and it came back as itself, not as a second row beside the dismissed one.
    expect(db.table('prep_plans').filter((row) => row.signal_id === 'm-mia')).toHaveLength(1);
    // The trip nobody dismissed is untouched by the guard.
    expect(planFor(db, 'v-beach')?.status).toBe('active');
    // What the run reports is what it actually wrote.
    expect(second.plans).toBe(1);
  });

  it('is not written to at all, so the day it was decided survives', async () => {
    const db = household();
    const DISMISSED_AT = '2026-09-20T18:30:00.000Z';
    // A plan dismissed yesterday, already on the table when generation runs.
    db.seed('prep_plans', [{
      id: 'p-mia', family_id: 'f1', signal_kind: 'birthday', signal_id: 'm-mia',
      title: "Plan: Mia's Birthday", target_date: '2027-08-15', urgency: 'later',
      status: 'dismissed', created_by: 'parent-1',
      created_at: DISMISSED_AT, updated_at: DISMISSED_AT,
    }]);

    const result = await runPrepGeneration(db, 'f1', null, TZ, GENERATED_AT);
    expect(result.ok).toBe(true);

    const row = planFor(db, 'm-mia');
    expect(row?.status).toBe('dismissed');
    // A scan is not a family decision: the row is skipped, not re-upserted, so
    // `updated_at` still says when the family decided.
    expect(row?.updated_at).toBe(DISMISSED_AT);
    // And the dismissed plan's step ladder is not rebuilt underneath it.
    expect(db.table('prep_plan_steps').filter((s) => s.plan_id === 'p-mia')).toHaveLength(0);
  });

  it('does not stop an ACTIVE plan from being refreshed as its date approaches', async () => {
    // The fix must not become "never update a plan": urgency is why generation
    // runs again at all. A stale active row is still brought up to date.
    const db = household();
    db.seed('prep_plans', [{
      id: 'p-beach', family_id: 'f1', signal_kind: 'trip', signal_id: 'v-beach',
      title: 'Get ready: Old Title', target_date: '2026-10-05', urgency: 'later',
      status: 'active', created_by: 'parent-1',
    }]);

    const result = await runPrepGeneration(db, 'f1', null, TZ, GENERATED_AT);
    expect(result.ok).toBe(true);

    const row = planFor(db, 'v-beach');
    expect(row?.id).toBe('p-beach');
    expect(row?.title).toBe('Get ready: Beach Trip');
    expect(row?.urgency).toBe('now');
    expect(row?.status).toBe('active');
  });
});

describe('a generation that cannot read what the family decided', () => {
  /** Fails only the prep_plans SELECT; every write still works, the way a refused read does. */
  function refuseReads(db: InMemorySupabase, error: { code: string; message: string }) {
    const realFrom = db.from.bind(db);
    const reply = { data: null, error, count: null, status: 500, statusText: 'Internal Server Error' };
    const refused: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(reply).then(resolve);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(reply);
        return () => refused;
      },
    });
    (db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = realFrom(table) as unknown as Record<string | symbol, unknown>;
      if (table !== 'prep_plans') return builder;
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop === 'select') return () => refused;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
  }

  it('writes nothing and reports the refusal, instead of un-dismissing everything', async () => {
    const db = household();
    const DISMISSED_AT = '2026-09-20T18:30:00.000Z';
    db.seed('prep_plans', [{
      id: 'p-mia', family_id: 'f1', signal_kind: 'birthday', signal_id: 'm-mia',
      title: "Plan: Mia's Birthday", target_date: '2027-08-15', urgency: 'later',
      status: 'dismissed', created_by: 'parent-1',
      created_at: DISMISSED_AT, updated_at: DISMISSED_AT,
    }]);

    refuseReads(db, { code: '57014', message: 'canceling statement due to statement timeout' });

    const result = await runPrepGeneration(db, 'f1', null, TZ, CRON_SWEEP_AT);

    // FAIL CLOSED: the caller is told, and nothing was written on a value the
    // function does not have.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('canceling statement due to statement timeout');
    expect(result.plans).toBe(0);

    expect(planFor(db, 'm-mia')?.status).toBe('dismissed');
    expect(planFor(db, 'm-mia')?.updated_at).toBe(DISMISSED_AT);
    // Not even the trip, which has no row yet: a read that failed is not a
    // family with nothing dismissed.
    expect(planFor(db, 'v-beach')).toBeUndefined();
    expect(db.table('prep_plan_steps')).toHaveLength(0);
  });
});
