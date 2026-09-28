// Prep-plan generation reads back the ids of the plans it just upserted so it
// can hang each plan's step ladder on it (lib/planning/prep-server.ts). That
// read asked for EVERY prep plan the family had ever had — and plans are never
// deleted, one accrues per trip and per expiring document — with no range, so
// past PostgREST's `db-max-rows` the answer was a prefix. A new plan whose row
// fell outside it found no id, its steps were silently skipped, and the run
// still reported the plan as generated: a card with an empty checklist.
// The two reads now ask only for the plans this run generated.
// (SRV-001 census, SRV-C07.)
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-21T12:00:00Z');
const CAP = 5;

function household() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: {
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
    defaults: { prep_plans: { status: 'active' } },
    maxRows: CAP,
  });
  // Years of past plans, as many as one response will carry.
  db.seed('prep_plans', Array.from({ length: CAP }, (_, i) => ({
    id: `old-${i}`, family_id: 'f1', signal_kind: 'trip', signal_id: `past-trip-${i}`,
    title: `Get ready: Trip ${i}`, target_date: '2025-06-01', urgency: 'later', status: 'done',
  })));
  db.seed('vacations', [{ id: 'v-beach', family_id: 'f1', title: 'Beach Trip', start_date: '2026-10-05' }]);
  return db;
}

describe('a new prep plan gets its steps however many plans came before it', () => {
  it('writes the step ladder for the plan it generated', async () => {
    const db = household();
    const result = await runPrepGeneration(db, 'f1', 'parent-1', 'UTC', NOW);
    expect(result).toMatchObject({ ok: true, plans: 1 });

    const plan = db.table('prep_plans').find((row) => row.signal_id === 'v-beach');
    expect(plan).toBeDefined();
    expect(db.table('prep_plan_steps').filter((s) => s.plan_id === plan!.id).length).toBeGreaterThan(0);
  });
});
