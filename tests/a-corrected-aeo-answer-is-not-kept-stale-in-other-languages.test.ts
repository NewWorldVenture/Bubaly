// Admin reach N9 — fixing a published AEO answer changed only the English.
//
// updateAeoQuestion rewrote marketing_aeo_questions and left
// marketing_aeo_question_translations alone. That table holds a row per
// (question, locale) — 360 machine translations seeded by migration 0279 — and
// nothing in the app writes it, so on every non-English locale
// localizeAeoQuestions swapped the OLD translated answer back in, on the page
// and in its FAQPage structured data. An operator correcting a wrong claim
// fixed English only. The retired-claims filter also ran on the English text
// alone, never on the translation that replaced it.
//
// Driven through the REAL action and the REAL public readers
// (readAeoQuestionsForPath, then localizeAeoQuestions) against the in-memory
// database. Negative controls: before the fix a French reader still got the
// old answer after the edit, and a translation stating a retired claim was
// shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, requireMarketingAdmin: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.db }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: h.requireMarketingAdmin,
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));

const { updateAeoQuestion } = await import('@/app/(app)/admin/marketing/actions');
const { readAeoQuestionsForPath, localizeAeoQuestions } = await import('@/lib/marketing/aeo');

let db: InMemorySupabase;
const question = (id: string, path: string, answer: string) => ({
  id, question: `What does ${id} cover?`, answer, entity: null, pattern: 'faq', source_path: path,
  status: 'published', clarity_score: 80, last_reviewed: null, metadata: {}, created_by: null,
});
const translation = (questionId: string, locale: string, answer: string) => ({
  id: `${questionId}-${locale}`, question_id: questionId, locale, question: `Que couvre ${questionId} ?`, answer, source: 'machine', reviewed_at: null,
});
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}
async function french(path: string) {
  const read = await readAeoQuestionsForPath(path);
  return (await localizeAeoQuestions(read.questions, 'fr-FR')).map((q) => q.answer);
}

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  db.seed('marketing_aeo_questions', [
    question('q1', '/pricing', 'Plans start at $5 a month.'),
    question('q2', '/features', 'Lists, meals and the calendar.'),
  ]);
  db.seed('marketing_aeo_question_translations', [
    translation('q1', 'fr-FR', 'Les forfaits commencent à 5 $ par mois.'),
    translation('q1', 'de-DE', 'Tarife ab 5 $ im Monat.'),
    translation('q2', 'fr-FR', 'Listes, repas et calendrier.'),
  ]);
  h.requireMarketingAdmin.mockReset().mockResolvedValue({ supabase: db, actorId: 'admin-1', actorEmail: 'admin@example.test' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a corrected AEO answer', () => {
  it('is not served in its old translation to a French reader', async () => {
    expect(await french('/pricing')).toEqual(['Les forfaits commencent à 5 $ par mois.']);
    await updateAeoQuestion(form({ id: 'q1', question: 'What does q1 cover?', answer: 'Plans start at $8 a month.', status: 'published', source_path: '/pricing' }));
    expect(await french('/pricing')).toEqual(['Plans start at $8 a month.']);
    // Every locale of that question went; another question's stayed.
    expect(db.table('marketing_aeo_question_translations').map((row) => row.id)).toEqual(['q2-fr-FR']);
    expect(await french('/features')).toEqual(['Listes, repas et calendrier.']);
  });

  it('the control: an edit that leaves the English text alone keeps its translations', async () => {
    await updateAeoQuestion(form({ id: 'q1', question: 'What does q1 cover?', answer: 'Plans start at $5 a month.', status: 'published', source_path: '/pricing', clarity_score: '95' }));
    expect(db.table('marketing_aeo_question_translations')).toHaveLength(3);
    expect(await french('/pricing')).toEqual(['Les forfaits commencent à 5 $ par mois.']);
  });

  it('a translation that states a retired claim is not shown', async () => {
    db.table('marketing_aeo_question_translations')[0].answer = 'Yes, with native iOS and Android companions.';
    expect(await french('/pricing')).toEqual(['Plans start at $5 a month.']);
  });
});
