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

const CORRECTION = readFileSync(
  join(ROOT, 'supabase/migrations/0280_aeo_answers_agree_in_number.sql'),
  'utf8',
);

const GERMAN = readFileSync(
  join(ROOT, 'supabase/migrations/0281_german_clauses_close.sql'),
  'utf8',
);

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

// 0279's "what is X" frame hard-codes a singular copula and `Reminders` is a
// plural noun phrase in all six languages, so six rows read as broken grammar.
// The templates now carry number, and 0280 is what carries the six rows that
// regeneration changed to a database 0279 has already run on.
//
// Proven against real Postgres (16.13) at authoring time: 0277, then the 60
// published English parents, then 0279 and 0280 in order.
//   after 0279 -> 'O que é os Lembretes?' / 'Os Lembretes é a parte'
//   after 0280 -> 'O que são os Lembretes?' / 'Os Lembretes são a parte',
//                 and the same in de, es, fr, it, nl; still 360 rows
//   fixture: pt-PT set to source='human' + reviewed_at, es-ES stamped
//            reviewed_at while still machine
//   replayed -> both kept their text; the other four corrected
//   third pass -> zero rows differing from the snapshot
describe('AEO number agreement — 0280', () => {
  const statements = CORRECTION.split(/\n(?=update public\.marketing_aeo_question_translations)/)
    .filter((chunk) => chunk.trimStart().startsWith('update public.'));

  it('corrects one row per locale and nothing else', () => {
    expect(statements).toHaveLength(6);
    const locales = statements.map((s) => /and t\.locale = '([a-z]{2}-[A-Z]{2})'/.exec(s)?.[1]);
    expect(locales).toEqual(['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']);
    // One English parent — the only brand term that reaches a copula frame.
    const parents = new Set(statements.map((s) => /and q\.question = '([^']*)'/.exec(s)?.[1]));
    expect([...parents]).toEqual(['What is Reminders?']);
  });

  it('leaves a row a native speaker has touched exactly as they left it', () => {
    for (const statement of statements) {
      expect(statement).toContain("and t.source = 'machine'");
      expect(statement).toContain('and t.reviewed_at is null;');
    }
  });

  it('writes the plural copula each language actually needs', () => {
    // Number agreement is per language, not a search-and-replace of one word.
    expect(CORRECTION).toContain('Was sind Erinnerungen?');
    expect(CORRECTION).toContain('¿Qué son los Recordatorios?');
    expect(CORRECTION).toContain('Les Rappels désignent');
    expect(CORRECTION).toContain('Che cosa sono i Promemoria?');
    expect(CORRECTION).toContain('Wat zijn Herinneringen?');
    expect(CORRECTION).toContain('O que são os Lembretes?');
    // And none of the singular forms survive anywhere in it.
    for (const singular of ['O que é os', 'Os Lembretes é', '¿Qué es los', 'I Promemoria è',
                            'Was ist Erinnerungen', 'Wat is Herinneringen', 'Les Rappels désigne ']) {
      expect(CORRECTION).not.toContain(singular);
    }
  });
});

// German sets a subordinate clause off with a comma on BOTH sides, and two of
// the German frames continue after the {blurb} slot with a finite verb. Where a
// clausal vocabulary item landed in one, the clause opened and never closed.
// Same root cause as 0280 one level up — a frame that requires something of
// whatever fills its slot — so the templates now mark which items carry a
// clause and use a slot form that closes it.
//
// Proven against real Postgres (16.13): 0277, the 60 published English parents,
// then 0279, 0280 and 0281 in order.
//   -> 'der rechtzeitige Erinnerungen, damit nichts Wichtiges untergeht, umfasst.'
//   -> 'lassen Sie das Planen von Reisen, an denen die ganze Familie Freude
//       hat, sich von selbst erledigen.'
//   fixture: one de-DE row source='human' + reviewed_at, one machine but
//            stamped reviewed_at -> both kept their text verbatim
//   replayed -> zero rows differing from the snapshot
describe('German clause punctuation — 0281', () => {
  const statements = GERMAN.split(/\n(?=update public\.marketing_aeo_question_translations)/)
    .filter((chunk) => chunk.trimStart().startsWith('update public.'));

  it('touches German and nothing else', () => {
    expect(statements).toHaveLength(10);
    const locales = new Set(
      statements.map((s) => /and t\.locale = '([a-z]{2}-[A-Z]{2})'/.exec(s)?.[1]),
    );
    expect([...locales]).toEqual(['de-DE']);
  });

  it('leaves a row a native speaker has touched exactly as they left it', () => {
    for (const statement of statements) {
      expect(statement).toContain("and t.source = 'machine'");
      expect(statement).toContain('and t.reviewed_at is null;');
    }
  });

  it('closes the clause before the frame verb', () => {
    expect(GERMAN).toContain('damit nichts Wichtiges untergeht, umfasst.');
    expect(GERMAN).toContain('an denen die ganze Familie Freude hat, sich von selbst erledigen.');
    expect(GERMAN).toContain('eine Familie zu führen, sich von selbst erledigen.');
    // No unclosed one survives in the DATA. The header quotes the broken form
    // on purpose, to show what it is correcting, so this reads the statements.
    const written = statements.join('\n');
    expect(written).not.toMatch(/untergeht umfasst/);
    expect(written).not.toMatch(/hat sich von selbst/);
    expect(written).not.toMatch(/führen sich von selbst/);
  });

  // 0280 gave this row its plural copula; its blurb is also one of the clausal
  // six, so it needs both and the text here must already carry 0280's.
  it('carries 0280 forward on the row that needs both corrections', () => {
    const both = statements.find((s) => s.includes("q.question = 'What is Reminders?'"));
    expect(both).toBeDefined();
    expect(both).toContain('Was sind Erinnerungen?');
    expect(both).toContain('untergeht, umfasst.');
  });
});
