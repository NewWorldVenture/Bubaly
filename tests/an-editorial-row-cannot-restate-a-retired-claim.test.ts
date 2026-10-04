import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RETIRED_CLAIMS, statesARetiredClaim } from '@/lib/marketing/retired-claims';

// After the 2026-10-04 copy correction shipped, production's /mobile still read
// "Bubaly is an installable app with native iOS and Android companions" — in
// its meta description, its Knowledge Center answer and its FAQPage structured
// data — because those come from admin-edited rows seeded by migration 0229,
// not from the catalogue. The readers now refuse a row that states a retired
// claim: the page's code value is used for SEO, and the answer is left out.

type Result = { data: unknown; error: unknown };
const tables = new Map<string, Result>();

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'not', 'order', 'abortSignal', 'limit', 'in']) {
    chain[method] = () => chain;
  }
  const result = () => tables.get(table) ?? { data: null, error: null };
  chain.maybeSingle = () => Promise.resolve(result());
  chain.then = (resolve: (value: Result) => unknown) => Promise.resolve(result()).then(resolve);
  return chain;
}

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (table: string) => builder(table) }) }));

const RETIRED_ANSWER = 'Bubaly is an installable app with native iOS and Android companions — your family operating system on every device.';
const row = (id: string, question: string, answer: string) => ({
  id, question, answer, entity: null, pattern: null, source_path: '/mobile', metadata: {}, clarity_score: 90, status: 'published',
});

describe('an editorial row cannot restate a retired claim', () => {
  beforeEach(() => {
    tables.clear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test');
  });

  it('recognises the row production still serves, and not ordinary copy', () => {
    expect(statesARetiredClaim(RETIRED_ANSWER)).toBe(true);
    expect(statesARetiredClaim('Start your 5-day trial — no card needed.')).toBe(false);
    // A keyword the 0229 seed tracks, not a claim: "free planner" is not "free plan".
    expect(statesARetiredClaim('best free planner for parents')).toBe(false);
    expect(statesARetiredClaim(null, undefined, 'Bubaly has a free plan.')).toBe(true);
    expect(RETIRED_CLAIMS.length).toBeGreaterThanOrEqual(6);
  });

  it('leaves a retired answer out of a page’s Knowledge Center', async () => {
    tables.set('marketing_aeo_questions', {
      data: [
        row('q1', 'What is Bubaly on Mobile — Your Family OS Everywhere?', RETIRED_ANSWER),
        row('q2', 'Can I install Bubaly on my phone?', 'Yes — add it to your home screen from the browser.'),
      ],
      error: null,
    });
    const { readAeoQuestionsForPath } = await import('@/lib/marketing/aeo');
    const read = await readAeoQuestionsForPath('/mobile');
    expect(read.available).toBe(true);
    expect(read.questions.map((q) => q.id)).toEqual(['q2']);
  });

  it('leaves it out of the page payload fallback too', async () => {
    tables.set('marketing_aeo_questions', { data: null, error: { message: 'unavailable' } });
    tables.set('marketing_pages', {
      data: {
        aeo: {
          questions: [
            { question: 'What is Bubaly on Mobile?', answer: RETIRED_ANSWER },
            { question: 'Does it need an app store?', answer: 'No — it installs from the browser.' },
          ],
        },
      },
      error: null,
    });
    const { readAeoQuestionsForPath } = await import('@/lib/marketing/aeo');
    const read = await readAeoQuestionsForPath('/mobile');
    expect(read.questions.map((q) => q.question)).toEqual(['Does it need an app store?']);
  });

  it('leaves it out of the site-wide and per-category readers', async () => {
    tables.set('marketing_aeo_questions', {
      data: [row('q1', 'What is Bubaly on Mobile?', RETIRED_ANSWER), row('q2', 'Is there a trial?', 'Yes, five days.')],
      error: null,
    });
    const { readPublishedAeoQuestions, readAeoQuestionsForCategory } = await import('@/lib/marketing/aeo');
    expect((await readPublishedAeoQuestions()).questions.map((q) => q.id)).toEqual(['q2']);
    expect((await readAeoQuestionsForCategory('mobile', 4)).questions.map((q) => q.id)).toEqual(['q2']);
  });

  it('uses the page’s own description instead of a retired one from the SEO store', async () => {
    tables.set('marketing_pages', {
      data: { title: 'Bubaly on Mobile', summary: null, seo: { description: RETIRED_ANSWER }, status: 'published' },
      error: null,
    });
    const { getSeoPage, resolveMarketingMetadata } = await import('@/lib/marketing/seo');
    const page = await getSeoPage('/mobile');
    expect(page?.title).toBe('Bubaly on Mobile');
    expect(page?.description).toBeNull();

    const metadata = await resolveMarketingMetadata('/mobile', {
      title: 'Bubaly on Mobile',
      description: 'Install Bubaly from the browser on iPhone, iPad or Android.',
    });
    expect(metadata.description).toBe('Install Bubaly from the browser on iPhone, iPad or Android.');
  });

  it('still lets the store override with a description that is true', async () => {
    tables.set('marketing_seo_pages', {
      data: { title: 'Mobile', meta_description: 'Installs from the browser on any phone.', metadata: {}, status: 'active' },
      error: null,
    });
    const { getSeoPage } = await import('@/lib/marketing/seo');
    expect((await getSeoPage('/mobile'))?.description).toBe('Installs from the browser on any phone.');
  });
});
