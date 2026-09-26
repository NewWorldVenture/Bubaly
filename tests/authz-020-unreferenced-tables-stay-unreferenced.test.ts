import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AUTHZ-020's hazard, closed without making AUTHZ-020's decision.
//
// Sixteen tables carry a role-blind write policy and are referenced by NOTHING
// in the application. Six already hold seed rows. The finding's remedy — drop
// them, or revoke client DML and leave them service-role-only — is a product
// decision the audit deliberately does not make, because dropping a table is
// not reversible by whoever reads the row next.
//
// But the row names a hazard that needs no decision at all:
//
//   "a developer wiring the real feature can bind to sync_conflict_resolutions
//    instead of sync_conflicts and get a table nobody has ever guarded"
//
// That is live rather than theoretical because the names are NEAR-MISSES of
// tables the sync subsystem really uses: sync_conflicts is used and
// sync_conflict_resolutions is not; sync_calendars is used and
// sync_calendar_shares is not. The two differ by a suffix, autocomplete offers
// both, and binding to the wrong one produces working code over an unguarded
// table — no error, no screen showing anything wrong.
//
// So this is a TRIPWIRE, not a fix. It asserts only that the sixteen are still
// unreferenced. The moment one is wired up it fails and names AUTHZ-020, which
// forces the drop-or-revoke decision at the one moment it is cheap to make:
// before a feature depends on the table. Wiring one of these up is not
// forbidden — the test says so — it just may not happen SILENTLY.
//
// Deliberately NOT asserted here: anything about policies, grants or seed rows.
// Those live in the migration replay and the boundary probes, and duplicating
// them in a source scan would give two places to update and one of them would
// go stale.

/**
 * The sixteen, verbatim from AUTHZ-020. Ordered as the finding lists them so a
 * reader can diff the two by eye.
 *
 * `family_knowledge_nodes` and `family_knowledge_edges` are deliberately ABSENT:
 * the AUTHZ-011 triage returns eighteen, and those two extra ARE named in the
 * tree (lib/twin/project.ts and lib/family/actions.ts) as object keys in a
 * legacy→current mapping. AUTHZ-020's narrower list is right on its own stated
 * test — search by bare table name — and this file uses that same test, so it
 * must use that same list.
 */
const UNREFERENCED = [
  'family_stress_predictions',
  'social_campaigns',
  'social_post_assets',
  'sync_calendar_shares',
  'sync_change_logs',
  'sync_conflict_resolutions',
  'sync_event_attendees',
  'sync_note_folders',
  'sync_notes',
  'sync_settings',
  'vacation_activity_logs',
  'vacation_activity_tickets',
  'vacation_audit_logs',
  'vacation_checklists',
  'vacation_destinations',
  'vacation_notifications',
] as const;

/** The used siblings whose names the sixteen shadow. Guards the guard. */
const USED_NEIGHBOURS = ['sync_conflicts', 'sync_calendars', 'sync_jobs'] as const;

const ROOTS = ['app', 'lib', 'components', 'hooks', 'scripts', 'mobile'];

/**
 * The generated Supabase schema mirror, excluded — and it is worth saying why,
 * because including it is what a first attempt at this file did and every
 * assertion below failed.
 *
 * `lib/database.types.ts` names EVERY table in the database, so with it in
 * scope all sixteen read as "referenced" and the check inverts into always-red
 * while proving nothing. It is also the reason AUTHZ-020's own "zero
 * references" claim is not contradicted by it: naming a table in generated
 * types is not the application using it. It is the only generated file in the
 * tree that names these tables.
 *
 * Excluding it does NOT weaken the controls, which was checked rather than
 * assumed: with it out of scope `sync_conflicts` is still found in 5 files,
 * `sync_calendars` in 4 and `sync_jobs` in 3, so the search demonstrably still
 * finds real usage.
 */
const GENERATED = new Set(['lib/database.types.ts']);
const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', 'out', 'dist', 'coverage',
  'test-results', 'playwright-report', 'ios', 'android', '.expo',
]);
const CODE = /\.(ts|tsx|js|jsx|mjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let dirent;
    try { dirent = statSync(full); } catch { continue; }
    if (dirent.isDirectory()) walk(full, out);
    else if (CODE.test(entry)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r)).filter((f) => !GENERATED.has(f));

/**
 * Bare-name search, the same test AUTHZ-020 used — not `.from('…')` only.
 *
 * The word boundary on BOTH sides is what makes it usable: without a trailing
 * one, `sync_notes` would match `sync_note_folders` and the two rows could
 * never be told apart. `\w` covers the underscore, so `\b` sits exactly where a
 * table name ends.
 */
function referencesOf(table: string): string[] {
  const pattern = new RegExp(`\\b${table}\\b`);
  return FILES.filter((f) => pattern.test(readFileSync(f, 'utf8')));
}

describe('AUTHZ-020: the sixteen unreferenced tables are still unreferenced', () => {
  it('scans a real tree — the file list is not empty', () => {
    // Without this, a broken root or a bad extension filter would make every
    // assertion below pass over nothing at all.
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('the search can find a table that IS used — so a clean result means something', () => {
    // The vacuity control. If `referencesOf` were broken, the sixteen would
    // read as unreferenced no matter what the tree held.
    for (const used of USED_NEIGHBOURS) {
      expect(referencesOf(used).length, `${used} should be found in the tree`).toBeGreaterThan(0);
    }
  });

  it('distinguishes a near-miss from its used sibling', () => {
    // The specific confusion AUTHZ-020 warns about: these differ by a suffix,
    // and a search that cannot separate them cannot report the hazard either.
    expect(referencesOf('sync_conflicts').length).toBeGreaterThan(0);
    expect(referencesOf('sync_conflict_resolutions')).toEqual([]);
    expect(referencesOf('sync_calendars').length).toBeGreaterThan(0);
    expect(referencesOf('sync_calendar_shares')).toEqual([]);
  });

  for (const table of UNREFERENCED) {
    it(`${table} is not referenced by application code`, () => {
      const hits = referencesOf(table);
      expect(
        hits,
        hits.length === 0 ? '' :
          `${table} is now referenced by ${hits.join(', ')}.\n\n` +
          'This is not a failure of the code — it is AUTHZ-020 coming due.\n' +
          'That table carries a role-blind write policy and has never been\n' +
          'guarded, and six of the sixteen already hold seed rows a member\n' +
          'could have written. Before this feature ships, decide AUTHZ-020 for\n' +
          'this table: drop it, or revoke client DML and drive it service-role\n' +
          'only, or give it a real policy. Then remove it from UNREFERENCED\n' +
          'here and say in the finding which was chosen.',
      ).toEqual([]);
    });
  }
});
