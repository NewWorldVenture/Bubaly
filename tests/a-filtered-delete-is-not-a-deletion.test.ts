import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

/**
 * RLS FILTERS A WRITE. IT DOES NOT REFUSE ONE.
 *
 * `delete from t where id = $1` under a policy the caller fails does not raise.
 * Postgres removes the rows the policy admits — none — and PostgREST answers
 * 204 with `error: null`. A client that branches on `error` alone therefore
 * cannot tell "removed" from "not yours to remove", and every module here took
 * the silence for success:
 *
 *   const { error } = await sb.from('medications').delete().eq('id', m.id);
 *   if (error) { toastError(...); return; }
 *   success('Medication deleted');      // over a prescription still in the table
 *
 * That is not hypothetical on these tables — it is the DESIGNED outcome of the
 * policies this audit shipped. 0328 made medications and medication_schedules
 * manager-only; 0323 gives health_visits, immunizations and care_log Rule B, so
 * the subject of a medical record may not erase it; 0330 makes a behaviour note
 * its author's; 0331 makes a journal nobody else's; 0324 scopes a safety
 * check-in by created_by. Tightening the database is what turned a dormant
 * client bug into a live one, and nothing in the client moved with it.
 *
 * `.select('id')` is the fix: it makes PostgREST return the rows it actually
 * touched, so an empty result is an answer rather than an absence. The
 * `family_id` filter alongside it is defence in depth in the house style — the
 * §7 service layer made the same change for the same reason, "family-scoped
 * where it previously filtered `id` alone and left tenancy to RLS".
 *
 * WHY THIS IS SCOPED BY TABLE. A `.delete()` on a table anyone in the family
 * may write is not lying when it reports success, because the filter cannot
 * bite. The list below is the tables whose policies deliberately DO bite, which
 * is exactly where the silence is wrong. Adding a row-level rule to a new table
 * means adding it here.
 *
 * The contrast worth keeping: `locator-module` has none of this, because every
 * write goes through a server action that checks `isManager` in CODE before it
 * queries — so it refuses honestly instead of filtering silently.
 */

/** Tables whose RLS deliberately filters some members' writes. */
const GATED = [
  // `medication_doses` is deliberately NOT here: 00261 gives it "Members can
  // manage medication_doses", so the policy cannot filter a legitimate member's
  // delete and reporting success over it is not a lie. Listing it would have
  // demanded a `.select()` that proves nothing — the list has to mean
  // "policies that bite" or it stops meaning anything.
  'medications', 'medication_schedules',
  'immunizations', 'health_visits', 'health_providers', 'insurance_policies',
  'medical_profiles', 'family_allergies',
  'behavior_logs', 'journal_entries', 'care_log', 'sleep_logs',
  'grades', 'screen_time_limits', 'health_metrics', 'health_goals',
  'safety_check_ins', 'member_locations', 'location_events',
];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Call sites of a FILTERED write on a gated table, with the chars that follow.
 *
 * `.delete()` and `.update(` both, because RLS treats them identically and this
 * guard originally covered only the first — which is exactly how three modules
 * ended up with a fixed delete and an unfixed update IN THE SAME FUNCTION:
 * immunizations-module, health-visits-module and health-module's symptom_logs
 * each had `.delete().eq('family_id').select('id')` two lines below
 * `.update(row).eq('id', form.id)`. The fix had been written down, cited a
 * migration by number, and stopped one statement short. A guard scoped to one
 * verb is what let that read as done.
 *
 * `.insert(` is deliberately NOT here: RLS REFUSES an insert with an error
 * rather than filtering it away, so branching on `error` is correct there and
 * demanding a readback would prove nothing.
 */
function gatedWrites(): { file: string; table: string; verb: string; window: string }[] {
  const hits: { file: string; table: string; verb: string; window: string }[] = [];
  for (const file of tsxFiles(join(ROOT, 'components'))) {
    const src = readFileSync(file, 'utf8');
    for (const table of GATED) {
      for (const verb of ['delete\\(\\)', 'update\\(']) {
        const re = new RegExp(`from\\('${table}'\\)[\\s\\S]{0,40}?\\.${verb}`, 'g');
        for (const m of src.matchAll(re)) {
          hits.push({
            file: file.slice(ROOT.length + 1), table,
            verb: verb.startsWith('delete') ? 'delete' : 'update',
            window: src.slice(m.index, m.index + 320),
          });
        }
      }
    }
  }
  return hits;
}

describe('a filtered delete is not a deletion', () => {
  const deletes = gatedWrites();

  it('finds the call sites it claims to cover', () => {
    // Non-vacuity. A regex that stops matching turns this file into a pass over
    // nothing, which is the failure mode these guards exist to avoid.
    expect(deletes.length, 'no gated writes found in components/ — the matcher broke').toBeGreaterThanOrEqual(8);
    expect(new Set(deletes.map((d) => d.file)).size).toBeGreaterThanOrEqual(5);
    // Both verbs really are covered, so a future pass cannot quietly lose one.
    expect(new Set(deletes.map((d) => d.verb))).toEqual(new Set(['delete', 'update']));
  });

  it('every write on a gated table asks which rows it touched', () => {
    const silent = deletes
      .filter((d) => !/\.select\(/.test(d.window))
      .map((d) => `${d.file} — ${d.verb} on ${d.table} without .select(), so a filtered write reads as a successful one`);
    expect(
      silent,
      'RLS filters these deletes rather than refusing them. Chain .select(\'id\').maybeSingle() '
      + 'and treat an empty result as a refusal:\n' + silent.map((s) => `  ${s}`).join('\n'),
    ).toEqual([]);
  });

  it('every write on a gated table is family-scoped, not left to RLS alone', () => {
    const unscoped = deletes
      .filter((d) => !/\.eq\('family_id'/.test(d.window))
      .map((d) => `${d.file} — ${d.verb} on ${d.table} filters id alone and leaves tenancy to RLS`);
    expect(unscoped, unscoped.join('\n')).toEqual([]);
  });

  it('the refusal string exists in every catalogue that carries keys', () => {
    // The message these call sites reach for. An empty regional variant merges
    // down its fallback chain, so only the populated catalogues must have it.
    const dir = join(ROOT, 'lib/i18n/messages');
    const populated = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>] as const)
      .filter(([, cat]) => Object.keys(cat).length > 0);
    expect(populated.length).toBeGreaterThanOrEqual(7);
    for (const [name, cat] of populated) {
      expect(cat['actions.couldNotDeleteThatRecord'], `${name} is missing the refusal string`).toBeTruthy();
    }
  });
});
