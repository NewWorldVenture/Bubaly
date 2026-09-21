import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Nine times in two operative documents, a migration was named by a filename
// that does not exist — and in five of those the NUMBER was occupied by a
// completely different migration.
//
//   finalaudit.md said S-03's RLS half was `0299_child_logins_write_boundary.sql`.
//   `0299` is `0299_family_keeps_a_manager.sql`, about something else entirely,
//   and the write-boundary file had been DROPPED in the two-audit merge because
//   `0297` already covered it (audit/claude-1.md:6439). S-04 pointed at `0300`
//   and S-05 at `0301`; the files are at `0320` and `0321`, and `0300`/`0301`
//   now hold `entitlement_is_not_client_writable` and `notification_authorship`.
//
//   docs/PENDING_PROD_MIGRATIONS.md — the document whose entire job is to be
//   followed by hand — named `0137_child_login_throttle.sql`,
//   `0138_onboarding_imports.sql`, `0138_demo_sessions.sql` and
//   `0142_family_signals.sql`. All four had been renumbered to five digits to
//   break a duplicate version prefix, so none of them was there.
//
// The shape is worth naming, because it is not a typo class. Every one of these
// was CORRECT when written and was broken by a LATER rename — a merge that
// renumbered, a de-duplication that appended a digit, a drop that was the right
// call. Prose does not move when a file does. And the failure is silent in the
// most dangerous way available: `supabase db push` applies the DIRECTORY, so
// the database ends up right while the document that tells a human what is in
// it is wrong. It only surfaces when somebody applies by name — which is
// exactly what an owner does when applying one migration rather than all of
// them, and is the operation this repository's own runbook describes.
//
// So this guard is on the two documents that are ACTED ON, not on every .md in
// the repository. audit/*.md and docs/AGENT_HANDOFF.md are archives: they record
// what was true at the time and are supposed to keep saying it.
const GUARDED = ['finalaudit.md', 'docs/PENDING_PROD_MIGRATIONS.md'] as const;

/**
 * A document sometimes has to QUOTE a name that is dead — that is what a record
 * of a correction is. So a reference wrapped in markdown strikethrough,
 * ~~`0299_child_logins_write_boundary.sql`~~, is read here as a historical
 * citation and is not required to exist.
 *
 * This is a narrow convention rather than a loophole, and the reason is that it
 * cannot be applied by accident: striking a name through renders it struck for
 * every human reader too, so a name you intend somebody to ACT on cannot end up
 * inside these marks without the mistake being visible on the page. An
 * allowlist keyed by name would not have that property — it lives in a test
 * file nobody reads while looking at the document.
 */
const STRUCK = /~~`(\d{4,5}_[a-z0-9_]+?)(\.sql)?`~~/g;

/** `0297_sensitive_tables_respect_role` — with or without the .sql, backticked. */
const MIGRATION_REF = /`(\d{4,5}_[a-z0-9_]+?)(\.sql)?`/g;

function migrationStems(): Set<string> {
  return new Set(
    readdirSync('supabase/migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -4)),
  );
}

/** Every migration this document points a reader AT — struck citations excluded. */
function referencedIn(doc: string): string[] {
  const text = readFileSync(join(process.cwd(), doc), 'utf8').replace(STRUCK, '');
  return [...text.matchAll(MIGRATION_REF)].map((m) => m[1]);
}

/** Every migration this document names as dead. */
function struckIn(doc: string): string[] {
  const text = readFileSync(join(process.cwd(), doc), 'utf8');
  return [...text.matchAll(STRUCK)].map((m) => m[1]);
}

describe('a document that is acted on does not name a migration that is not there', () => {
  const onDisk = migrationStems();

  it.each(GUARDED)('%s names only migrations that exist', (doc) => {
    const missing = [...new Set(referencedIn(doc))]
      .filter((stem) => !onDisk.has(stem))
      .filter((stem) => !onDisk.has(stem));

    expect(missing,
      `${doc} names ${missing.length} migration(s) with no file in supabase/migrations/: ` +
      `${missing.join(', ')}. Either the file was renamed or renumbered and the prose did not ` +
      'follow, or it was dropped. Find where it went — do not simply delete the reference, and ' +
      'check whether the NUMBER it cites is now occupied by something else, because that is how ' +
      'a reader applies the wrong migration.',
    ).toEqual([]);
  });

  // The renumbering case is worse than a dangling name, and it is the one a
  // reader cannot spot: the reference resolves to a real, applicable migration
  // that does something entirely different. Report it separately so the failure
  // message can say so.
  it.each(GUARDED)('%s does not cite a number that now belongs to a different migration', (doc) => {
    const byNumber = new Map<string, string>();
    for (const stem of onDisk) byNumber.set(stem.split('_')[0], stem);

    const hijacked = [...new Set(referencedIn(doc))]
      .filter((stem) => !onDisk.has(stem))
      .map((stem) => ({ cited: stem, occupant: byNumber.get(stem.split('_')[0]) }))
      .filter((x) => x.occupant !== undefined);

    expect(hijacked,
      `${doc} cites ${hijacked.length} migration number(s) that exist but hold something else: ` +
      hijacked.map((x) => `"${x.cited}" -> the file at that number is "${x.occupant}"`).join('; ') +
      '. Applying by that number applies the wrong migration.',
    ).toEqual([]);
  });

  // The convention cuts both ways. A name inside strikethrough is being called
  // DEAD, so if a file by that name is sitting on disk the document is telling
  // the reader to ignore something live — the same defect as the one this guard
  // was written for, pointing the other way.
  it.each(GUARDED)('%s does not strike through a migration that actually exists', (doc) => {
    const wronglyStruck = struckIn(doc).filter((stem) => onDisk.has(stem));
    expect(wronglyStruck,
      `${doc} strikes through ${wronglyStruck.length} migration(s) that DO exist: ` +
      `${wronglyStruck.join(', ')}. Strikethrough means "this name is dead"; these are not.`,
    ).toEqual([]);
  });

  // Non-vacuity floor. Both cases above pass trivially if the regex matches
  // nothing, and a guard that can pass by finding nothing is the failure mode
  // this audit has caught in its own probes more than once. So: prove the
  // parser reads real values, prove the disk listing is real, and prove the
  // comparison can still say NO.
  it('and the parser is reading real references, not matching nothing', () => {
    expect(onDisk.size).toBeGreaterThan(200);
    expect(onDisk.has('0297_sensitive_tables_respect_role')).toBe(true);

    for (const doc of GUARDED) {
      expect(referencedIn(doc).length, `${doc} suddenly names no migrations at all`).toBeGreaterThan(5);
    }

    // The corrections this guard was written for are present and resolve.
    const audit = referencedIn('finalaudit.md');
    for (const stem of ['0320_audit_logs_says_who_wrote_it', '0321_family_erasure_indexes',
      '0319_social_access_delete_matches_grant', '0296_family_credentials_manager_only']) {
      expect(audit, `finalaudit.md no longer names ${stem}`).toContain(stem);
      expect(onDisk.has(stem)).toBe(true);
    }

    // Negative control: a name in the guarded shape that is NOT on disk must be
    // reported as absent. If this ever comes back true the comparison is broken
    // and both cases above are vacuous.
    expect(onDisk.has('0999_a_migration_nobody_wrote')).toBe(false);
  });
});
