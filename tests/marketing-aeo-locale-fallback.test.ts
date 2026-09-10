import { beforeEach, describe, expect, it, vi } from 'vitest';

// Bubaly ships eleven locales but only seven message catalogues: fr-CA, es-MX
// and es-US are OVERLAYS that resolve their chrome through fr-FR and es-ES.
// The AEO translation table is keyed on the exact locale code, so keying the
// answers strictly gave those three readers translated chrome around a
// Knowledge Center that was not there at all — the same shape as the bug this
// whole area exists to fix, only silent, because an empty list renders nothing.

type Row = { question_id: string; locale: string; question: string; answer: string };

let rows: Row[] = [];
let readError: { message: string } | null = null;
let localesQueried: string[] = [];

const builder = () => ({
  select: () => builder(),
  in(column: string, values: string[]) {
    if (column === 'locale') localesQueried = values;
    return builder();
  },
  then(resolve: (value: { data: Row[] | null; error: unknown }) => unknown) {
    return Promise.resolve(
      readError ? { data: null, error: readError } : { data: rows, error: null },
    ).then(resolve);
  },
});

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => builder() }) }));

const QUESTIONS = [
  { id: 'q1', question: 'What is Bubaly?', answer: 'A family OS.', entity: null, pattern: null, sourcePath: '/features', topic: null, category: null },
  { id: 'q2', question: 'Does it handle chores?', answer: 'Yes.', entity: null, pattern: null, sourcePath: '/features', topic: null, category: null },
];

async function localize(locale: string) {
  const { localizeAeoQuestions } = await import('@/lib/marketing/aeo');
  return localizeAeoQuestions(QUESTIONS, locale);
}

describe('the Knowledge Center follows the same locale chain as the chrome around it', () => {
  beforeEach(() => {
    rows = [];
    readError = null;
    localesQueried = [];
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test');
  });

  it('reads a regional locale through its parent, the way the catalogue does', async () => {
    rows = [
      { question_id: 'q1', locale: 'fr-FR', question: "Qu'est-ce que Bubaly ?", answer: 'Un OS familial.' },
      { question_id: 'q2', locale: 'fr-FR', question: 'Gère-t-il les corvées ?', answer: 'Oui.' },
    ];
    const localized = await localize('fr-CA');

    expect(localesQueried).toEqual(['fr-CA', 'fr-FR']);
    expect(localized.map((q) => q.question)).toEqual([
      "Qu'est-ce que Bubaly ?",
      'Gère-t-il les corvées ?',
    ]);
  });

  it('walks the whole chain for a locale two steps from its root', async () => {
    rows = [{ question_id: 'q1', locale: 'es-ES', question: '¿Qué es Bubaly?', answer: 'Un SO familiar.' }];
    await localize('es-US');
    expect(localesQueried).toEqual(['es-US', 'es-MX', 'es-ES']);
  });

  it('prefers the nearest relative when both have a row', async () => {
    rows = [
      { question_id: 'q1', locale: 'fr-FR', question: 'France', answer: 'FR' },
      { question_id: 'q1', locale: 'fr-CA', question: 'Québec', answer: 'CA' },
    ];
    // Row order must not decide it, so assert both orderings.
    expect((await localize('fr-CA'))[0].question).toBe('Québec');
    rows.reverse();
    localesQueried = [];
    expect((await localize('fr-CA'))[0].question).toBe('Québec');
  });

  it('still drops a single untranslated question while others survive', async () => {
    rows = [{ question_id: 'q1', locale: 'fr-FR', question: "Qu'est-ce que Bubaly ?", answer: 'Un OS familial.' }];
    const localized = await localize('fr-FR');
    // A shorter list in the reader's own language beats a full one in English.
    expect(localized.map((q) => q.id)).toEqual(['q1']);
  });

  // MarketingAeoSection renders nothing at all for an empty list, so the last
  // question dropped takes the heading and the FAQPage schema with it.
  it('never lets the last dropped question take the whole section with it', async () => {
    rows = [];
    const localized = await localize('fr-FR');
    expect(localized).toHaveLength(2);
    expect(localized.map((q) => q.question)).toEqual(QUESTIONS.map((q) => q.question));
  });

  // `question` and `answer` are NOT NULL but the column accepts '', so a row is
  // not the same thing as an answer.
  it('does not let a blank overlay row displace a usable parent one', async () => {
    rows = [
      { question_id: 'q1', locale: 'fr-FR', question: "Qu'est-ce que Bubaly ?", answer: 'Un OS familial.' },
      { question_id: 'q1', locale: 'fr-CA', question: '   ', answer: '' },
    ];
    // Nearer, and empty. Ranking before discarding would hand the reader
    // nothing where a good fr-FR answer was sitting one step away.
    expect((await localize('fr-CA'))[0].answer).toBe('Un OS familial.');
    rows.reverse();
    expect((await localize('fr-CA'))[0].answer).toBe('Un OS familial.');
  });

  it('treats a blank row as no translation at all', async () => {
    rows = [{ question_id: 'q1', locale: 'fr-FR', question: '', answer: '' }];
    // Nothing usable in the set, so the section falls back rather than
    // rendering one blank accordion row.
    expect(await localize('fr-FR')).toEqual(QUESTIONS);
  });

  it('leaves English locales alone without querying at all', async () => {
    const localized = await localize('en-GB');
    expect(localized).toEqual(QUESTIONS);
    expect(localesQueried).toEqual([]);
  });

  it('falls back rather than blanking the section when the read fails', async () => {
    readError = { message: 'connection reset' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await localize('fr-FR')).toEqual(QUESTIONS);
    spy.mockRestore();
  });

  // A locale we do not ship has no chain to inherit, and guessing one would be
  // worse than admitting that.
  it('asks only for a locale it does not ship', async () => {
    await localize('sv-SE');
    expect(localesQueried).toEqual(['sv-SE']);
  });
});
