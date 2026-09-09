import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Knowledge Center seed (0279) is the one migration in the tree that writes
// over rows a human is expected to correct later: an admin opens
// /admin/marketing/aeo, fixes a machine-drafted French answer, marks it human —
// and then the next replay of this file must leave their text alone. That is a
// property of the ON CONFLICT clause on all 360 statements, and it is invisible
// in review: a missing WHERE reads exactly like a present one until the day it
// silently reverts somebody's work.
//
// Proven against real Postgres (16.13) at authoring time, both cases, before
// this test was written: 0277 applied over a parent table seeded with the 60
// published English questions, then 0279 replayed three times.
//   pass 1 (fresh, the CI replay case) -> 360 rows inserted across 6 locales
//   fixture: fr-FR row set to source='human' + reviewed_at, es-ES row left
//            source='machine' but stamped reviewed_at, de-DE row left a plain
//            unreviewed machine draft with its answer scribbled over
//   pass 2 -> fr-FR and es-ES kept their text verbatim; de-DE was refreshed
//            back to the generated German; still 360 rows
//   pass 3 -> zero rows differing from the pass-2 snapshot (idempotent)
//   rename/unpublish -> the renamed parent matched nothing and its existing
//            rows were left as they were, rather than written onto another row
const ROOT = join(__dirname, '..');
const SEED = readFileSync(
  join(ROOT, 'supabase/migrations/0279_seed_aeo_question_translations.sql'),
  'utf8',
);

const LOCALES = ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];

// Each statement is `insert ... select ... from ... where ... on conflict ...;`
const statements = SEED.split(/\n(?=insert into public\.marketing_aeo_question_translations)/)
  .filter((chunk) => chunk.trimStart().startsWith('insert into'));

describe('AEO translation seed — 0279', () => {
  it('seeds every published question in every locale the site speaks', () => {
    expect(statements).toHaveLength(360);

    const pairs = statements.map((statement) => {
      const locale = /^select q\.id, '([a-z]{2}-[A-Z]{2})'/m.exec(statement)?.[1];
      const english = / where q\.question = '((?:[^']|'')+)' and q\.status = 'published'/.exec(
        statement,
      )?.[1];
      expect(locale, statement.slice(0, 120)).toBeTruthy();
      expect(english, statement.slice(0, 120)).toBeTruthy();
      return `${english} ${locale}`;
    });

    expect(new Set(pairs).size).toBe(360); // no (question, locale) written twice
    for (const locale of LOCALES) {
      expect(pairs.filter((pair) => pair.endsWith(` ${locale}`))).toHaveLength(60);
    }
    expect(SEED).not.toMatch(/'en-US'/); // English stays in the parent, as the source
  });

  // The half that protects a reviewer's work.
  it('refreshes only the unreviewed machine drafts it owns', () => {
    const guarded = statements.filter(
      (statement) =>
        statement.includes('on conflict (question_id, locale) do update') &&
        statement.includes(
          "set question = excluded.question, answer = excluded.answer, updated_at = now()",
        ) &&
        statement.includes("where marketing_aeo_question_translations.source = 'machine'") &&
        statement.includes('and marketing_aeo_question_translations.reviewed_at is null;'),
    );
    expect(guarded).toHaveLength(360);
  });

  // A row that changed hands must not be dragged back to 'machine' by a replay,
  // so the conflict path never touches `source` at all — only the insert sets it.
  it('never rewrites the provenance of a row it did not insert', () => {
    expect(SEED).not.toMatch(/source = excluded\.source/);
    expect(statements.filter((statement) => statement.includes(", 'machine'"))).toHaveLength(360);
  });

  // 0229 seeds all 60 parents as published, so a fresh CI replay inserts all 360
  // rows. The header used to call that a zero-match no-op, which is the opposite
  // of what happens and would have excused never testing the insert path.
  it('does not describe a fresh replay as a no-op', () => {
    const header = SEED.slice(0, SEED.indexOf('insert into'));
    expect(header).not.toMatch(/matches nothing and inserts nothing/);
    expect(header).toMatch(/0229 has already/);
    expect(header).toMatch(/all 360 rows insert/);
  });
});
