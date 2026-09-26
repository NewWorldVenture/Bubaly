// Copy a family reads must not tell them to run a file.
//
// `/dashboard/experience` is in EVERY household's sidebar (`minLevel: 0`), and
// nothing in `app/` or `lib/` writes `experience_audits` — so the only state that
// page can reach is its empty state, whose description ended:
//
//   "Run seed_experience_audits_one_family.sql to populate a baseline."
//
// An internal seed-script filename, shown to every user of the product, on a page
// that cannot show anything else. Whether that page should ship at all is a
// product decision (recorded in finalaudit.md); a family being handed a SQL
// filename is not.
//
// So this sweeps the catalogue — where all user-facing copy now lives — for
// anything that reads like an internal file or a command to run. One entry is
// allowed, with its reason, because the audience is different: the Super Admin
// user page is operator-facing, and "run supabase/seed.sql" is the actual remedy
// for an unseeded permission matrix. That is the distinction worth encoding —
// not "no filenames anywhere", but "no filenames in front of a family".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

/**
 * Operator-facing strings, each with the surface that renders it. A key belongs
 * here only if the reader is an administrator of the deployment rather than a
 * member of a household — and the comment has to say which surface, so the claim
 * is checkable rather than asserted.
 */
const OPERATOR_FACING: Record<string, string> = {
  // app/(app)/admin/users/page.tsx — Super Admin → Users, permission matrix
  // empty state. The reader is whoever deploys Bubaly, and running the seed is
  // genuinely what fixes it.
  'users.runSupabaseSeedSqlAgainst': 'Super Admin → Users',
};

/** Reads like a file to run, a script to invoke, or a path into the repository. */
const INTERNAL_REFERENCE = /\b[\w./-]+\.(sql|mjs|sh|ts|tsx|py|ya?ml)\b|\bseed_\w+|\bnpm run \w|\bnpx \w|\bpsql\b|\bsupabase\/\w/;

describe('no copy a family reads names an internal file', () => {
  it('finds none outside the operator-facing allowance', () => {
    const offenders = Object.entries(MESSAGES)
      .filter(([key, value]) => INTERNAL_REFERENCE.test(value) && !(key in OPERATOR_FACING))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  // The allowance is a claim, so it has to stay true. A key that no longer names
  // an internal file does not need an exception, and one that has been deleted
  // should not leave a stale entry behind — this is the escape hatch that
  // `KNOWN_DUPLICATE_MIGRATIONS` taught the repository to keep honest.
  it.each(Object.keys(OPERATOR_FACING))('%s still exists and still needs its exception', (key) => {
    expect(MESSAGES[key], `${key} is gone from the catalogue; drop it from OPERATOR_FACING`).toBeDefined();
    expect(
      INTERNAL_REFERENCE.test(MESSAGES[key]),
      `${key} no longer names an internal file; drop it from OPERATOR_FACING`,
    ).toBe(true);
  });

  // The positive control: the pattern has to be able to see the string it was
  // written for. Without this, a regex that matches nothing passes case one.
  it('still recognises the copy this was written for', () => {
    expect(INTERNAL_REFERENCE.test('Run seed_experience_audits_one_family.sql to populate a baseline.')).toBe(true);
    expect(INTERNAL_REFERENCE.test('Run supabase/seed.sql against this project.')).toBe(true);
    expect(INTERNAL_REFERENCE.test('npm run db:audit:queries')).toBe(true);
    // And it must not flag ordinary copy that happens to contain a dot or a path.
    expect(INTERNAL_REFERENCE.test('Add a chore, then tap Done.')).toBe(false);
    expect(INTERNAL_REFERENCE.test('Visit bubaly.com to learn more.')).toBe(false);
    expect(INTERNAL_REFERENCE.test('Your plan renews on the 1st.')).toBe(false);
  });
});
