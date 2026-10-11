// What a cross-family medication reference does to the morning brief, as
// emitted.
//
// medication_schedules.medication_id is a single-column reference whose write
// policy checks only the schedule's own family_id, so a family's parent can
// save a schedule naming another family's medication (measured on a replay;
// the held 0497 makes the database refuse it). The morning brief runs in the
// notifications cron with the service client and embeds medications(name, …)
// through that column, so the foreign medication enters the brief.
//
// Owner review 6092976873 asked that the claim be bounded by what is EMITTED,
// not by the intermediate digest. This pins both halves:
//   * the delivered notification (title and body) never carries the foreign
//     medication's name. Its title is the count headline and its body is the
//     decision titles;
//   * its count does change: one planted schedule turns the delivered headline
//     from "1 due today" into "2 due today";
//   * the brief's internal digest carries the name. That internal
//     contamination and the wrong count are the demonstrated risk, and what
//     0497 closes at the source.
//
// lib/briefing/deliver.ts is not edited here; it stays with its owner.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { deliverMorningBriefs, morningTarget, readMorningBrief } from '@/lib/briefing/deliver';
import { scopeForSystem } from '@/lib/services/scope';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const TICK = new Date('2026-09-07T11:00:00Z');
const FOREIGN_NAME = 'Foreign-Family-Drug';

function households(db: InMemorySupabase, plantForeign: boolean) {
  db.seed('families', [{ id: 'fam-1', timezone: 'America/New_York' }, { id: 'fam-2', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: 'fam-1', user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
    { id: 'm-other', family_id: 'fam-2', user_id: 'auth-other', display_name: 'Pat', role: 'parent', is_active: true },
  ]);
  db.seed('medications', [
    { id: 'med-own', family_id: 'fam-1', name: 'Own-Family-Drug', member_id: 'm-parent', is_active: true },
    { id: 'med-foreign', family_id: 'fam-2', name: FOREIGN_NAME, member_id: 'm-other', is_active: true },
  ]);
  db.seed('medication_schedules', [
    { id: 'ms-own', family_id: 'fam-1', medication_id: 'med-own', time_of_day: '08:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null },
    ...(plantForeign
      ? [{ id: 'ms-foreign', family_id: 'fam-1', medication_id: 'med-foreign', time_of_day: '09:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null }]
      : []),
  ]);
}

async function deliveredToFamilyOne(plantForeign: boolean) {
  const db = createInMemorySupabase<DB>();
  households(db, plantForeign);
  await deliverMorningBriefs(db, TICK);
  return db.table('notifications').filter((r) => r.family_id === 'fam-1');
}

async function internalBriefOfFamilyOne(plantForeign: boolean) {
  const db = createInMemorySupabase<DB>();
  households(db, plantForeign);
  const scope = scopeForSystem(db, { id: 'fam-1', timezone: 'America/New_York' }, { now: TICK });
  const brief = await readMorningBrief(scope, morningTarget(TICK, 'America/New_York'));
  if (!brief.ok) throw new Error(brief.error);
  return brief.data;
}

describe('a schedule naming another family\'s medication', () => {
  it('never puts that medication\'s name into the delivered notification', async () => {
    const rows = await deliveredToFamilyOne(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(`${row.title}\n${row.body ?? ''}`).not.toContain(FOREIGN_NAME);
    }
  });

  it('does change the delivered count: the other family\'s dose is counted as this family\'s', async () => {
    const clean = await deliveredToFamilyOne(false);
    const planted = await deliveredToFamilyOne(true);
    expect(clean[0]?.title).toBe('Morning brief: 1 due today.');
    expect(planted[0]?.title).toBe('Morning brief: 2 due today.');
  });

  it('does reach the brief\'s internal digest, which is the contamination 0497 closes', async () => {
    const contaminated = JSON.stringify(await internalBriefOfFamilyOne(true));
    expect(contaminated).toContain(FOREIGN_NAME);
    // Control: without the planted schedule, nothing of the other family is there.
    const clean = JSON.stringify(await internalBriefOfFamilyOne(false));
    expect(clean).not.toContain(FOREIGN_NAME);
    expect(clean).toContain('Own-Family-Drug');
  });
});
