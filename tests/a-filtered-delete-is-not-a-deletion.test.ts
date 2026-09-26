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

/**
 * Tables whose RLS deliberately filters some members' writes.
 *
 * READ FROM THE PROBE, not written here. `docs/audit/gated-write-tables-check.sql`
 * derives this list from `pg_policies` on a database with all 345 migrations
 * applied, and FAILS in CI when the schema and the list disagree — so the list is
 * measured where it can be measured, and there is exactly one copy of it.
 *
 * The list used to live here, hand-written, and it lagged: 19 tables against the
 * 92 the catalog actually reports. Deriving it from the migration SQL was tried
 * three times and cannot work — a large share of these policies are generated
 * inside PL/pgSQL loops (`execute format('create policy %1$s_mng_update on
 * public.%1$I …', t)`), so the table is a loop variable and appears nowhere in
 * the `create policy` text. The probe's own header records all three attempts.
 *
 * WHY IT IS SCOPED BY TABLE AT ALL. A write on a table any family member may
 * write is not lying when it reports success, because the filter cannot bite.
 * Applying the rule there would demand a readback that proves nothing, and a
 * guard that cries wolf gets exemptions bolted onto it until it means nothing.
 */
const GATED: string[] = (() => {
  const sql = readFileSync(join(ROOT, 'docs/audit/gated-write-tables-check.sql'), 'utf8');
  const marker = 'recorded text[] := array[';
  const start = sql.indexOf(marker);
  const end = sql.indexOf('];', start);
  expect(start, 'the probe no longer carries a `recorded` list to read').toBeGreaterThan(-1);
  expect(end, 'the probe\'s `recorded` list is unterminated').toBeGreaterThan(start);
  const found = [...sql.slice(start + marker.length, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  // Non-vacuity: an empty or truncated parse would make every rule below pass
  // over nothing, which is the failure mode this whole file exists to avoid.
  expect(found.length, 'parsed no tables out of the probe — the marker moved').toBeGreaterThan(50);
  return [...new Set(found)];
})();

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

/**
 * The offenders the measured list just revealed, and the ONLY ones tolerated.
 *
 * Replacing the hand-written 19-table list with the 92 the catalog reports turned
 * this guard from "passing" into "naming 32 real sites". They are recorded rather
 * than waved through: each names file, verb and table, each must still MATCH (a
 * fixed site has to be deleted from this list, or the non-vacuity check below
 * fails), and nothing can be added without being read.
 *
 * This is a ratchet, not an exemption. It exists because the alternative was
 * either a 32-site sweep landing unreviewed alongside the measurement that found
 * them, or leaving the measurement out of the repo until the sweep was done — and
 * the measurement is the part that cannot be re-derived from the migration text.
 */
const KNOWN_UNFIXED: string[] = [
  // Empty, and the shape is kept so the next measurement has somewhere to land.
  // All 32 sites the measured list revealed are fixed: 21 were already reading
  // the row back and only needed `.eq('family_id', …)`; 11 needed both, and the
  // sharpest of those is marketplace-module's `remove`, where a filtered delete
  // left the listing in place and then deleted its photo from storage — data
  // loss, not merely a wrong toast.
]

/** `file verb table`, the shape KNOWN_UNFIXED records. */
const siteKey = (d: { file: string; verb: string; table: string }) => `${d.file} ${d.verb} ${d.table}`;

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
      // Only a write that names ONE row by id. A bulk write filtered by a set —
      // `update … .eq('family_id', f).eq('is_read', false)` in
      // notifications-module — touches zero rows whenever the set is empty, which
      // is the NORMAL outcome there (nothing was unread). A readback cannot tell
      // that from a refusal, so demanding one would add a check whose result
      // nobody can judge, which is worse than no check: it reads as covered.
      // `.eq('id', …)` is what makes an empty result an answer.
      .filter((d) => /\.eq\('id'/.test(d.window))
      .filter((d) => !KNOWN_UNFIXED.includes(siteKey(d)))
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
      .filter((d) => !KNOWN_UNFIXED.includes(siteKey(d)))
      .map((d) => `${d.file} — ${d.verb} on ${d.table} filters id alone and leaves tenancy to RLS`);
    expect(unscoped, unscoped.join('\n')).toEqual([]);
  });

  it('every recorded offender is still one — a fixed site leaves this list', () => {
    // Without this, a site could be fixed and its entry left behind, and the
    // list would quietly grow room for the next regression on the same file and
    // table. The entry must still name a write that is silent OR unscoped.
    const offending = new Set(
      deletes.filter((d) => (!/\.select\(/.test(d.window) && /\.eq\('id'/.test(d.window))
                         || !/\.eq\('family_id'/.test(d.window)).map(siteKey),
    );
    const stale = KNOWN_UNFIXED.filter((k) => !offending.has(k));
    expect(
      stale,
      'these are fixed (or gone). Delete them from KNOWN_UNFIXED so the guard '
      + 'starts enforcing the rule there again:\n' + stale.map((s) => `  ${s}`).join('\n'),
    ).toEqual([]);
  });

  it('the single-row rule is about the predicate, not the table', () => {
    // Calibration for the exemption above, so it cannot quietly widen. A write
    // naming one row by id must still be required to read back; one filtered by a
    // set must not.
    const named = (window: string) => !/\.select\(/.test(window) && /\.eq\('id'/.test(window);
    expect(named("from('notifications').delete().eq('id', id)")).toBe(true);
    expect(named("from('notifications').update({ is_read: true }).eq('family_id', f).eq('is_read', false)")).toBe(false);
    // And a single-row write that DOES read back is not an offender either.
    expect(named("from('notifications').delete().eq('id', id).select('id')")).toBe(false);
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
