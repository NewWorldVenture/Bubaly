import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { caseStudyPath } from '@/lib/marketing/case-study';
import { loadPublishedCaseStudy } from '@/lib/marketing/case-study-server';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.db }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/components/marketing/visual-mocks', () => ({
  PageWrap: ({ children }: { children: React.ReactNode }) => createElement('main', null, children),
  Container: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string) => SOURCE_MESSAGES[key] ?? key,
    getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
  };
});

const { default: Page, generateMetadata } = await import('@/app/(marketing)/customers/[slug]/page');
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const published = { id: 'published', title: 'A calmer week', slug: 'calmer-week', customer_name: 'Example family',
  summary: 'Their own account.', body: 'First paragraph.\n\nSecond paragraph.', result_metric: 'Reported two hours saved', is_published: true };
const props = (slug = published.slug) => ({ params: Promise.resolve({ slug }) });
beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  holder.db = db;
  db.seed('case_studies', [published, { ...published, id: 'draft', slug: 'private-draft', title: 'Private draft', is_published: false }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('published customer stories', () => {
  it('loads by exact slug and returns only the public fields of a published record', async () => {
    db.table('case_studies')[0].created_by = 'private-admin-id';
    const result = await loadPublishedCaseStudy(db, published.slug);
    expect(result).toMatchObject({ ok: true, study: { title: published.title, body: published.body } });
    expect(JSON.stringify(result)).not.toContain('private-admin-id');
    expect(await loadPublishedCaseStudy(db, 'private-draft')).toEqual({ ok: true, study: null });
    expect(await loadPublishedCaseStudy(db, 'unknown')).toEqual({ ok: true, study: null });
  });

  it('stops serving a story when publication is withdrawn', async () => {
    expect(await loadPublishedCaseStudy(db, published.slug)).toMatchObject({ ok: true, study: { id: 'published' } });
    db.table('case_studies')[0].is_published = false;
    expect(await loadPublishedCaseStudy(db, published.slug)).toEqual({ ok: true, study: null });
    await expect(Page(props())).rejects.toThrow('NOT_FOUND');
    expect(await generateMetadata(props())).toEqual({ robots: { index: false, follow: false } });
  });

  it.each(['.', '..', ''])('rejects the malformed imported slug %j instead of linking to another page', async (slug) => {
    expect(() => caseStudyPath(slug)).toThrow('Invalid customer story slug');
    expect(await loadPublishedCaseStudy(db, slug)).toEqual({ ok: true, study: null });
  });

  it('renders the recorded story and attributes the metric without claiming verification', async () => {
    const html = renderToStaticMarkup(await Page(props()));
    expect(html).toContain('A calmer week');
    expect(html).toContain('Second paragraph.');
    expect(html).toContain('Reported two hours saved');
    expect(html).not.toContain('Verified outcome');
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
    expect(schema).toMatchObject({ '@type': 'WebPage', name: published.title, description: published.summary });
    expect(schema.url).toMatch(/\/customers\/calmer-week$/);
    expect(schema).not.toHaveProperty('review');
    expect(schema).not.toHaveProperty('aggregateRating');
    expect(await generateMetadata(props())).toMatchObject({ title: published.title, description: published.summary,
      alternates: { canonical: '/customers/calmer-week' } });
  });

  it('renders stored markup as text, without executing or injecting it', async () => {
    db.table('case_studies')[0].body = '<script>sendCookies()</script>';
    const html = renderToStaticMarkup(await Page(props()));
    expect(html).toContain('&lt;script&gt;sendCookies()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(caseStudyPath('name/with ? chars')).toBe('/customers/name%2Fwith%20%3F%20chars');
  });

  it.each(['transport', 'query'] as const)('shows a retryable error rather than a missing story on %s failure', async (failure) => {
    if (failure === 'transport') vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('offline'); });
    else {
      const from = db.from.bind(db);
      vi.spyOn(db, 'from').mockImplementation((table) => {
        const query = from(table);
        vi.spyOn(query, 'maybeSingle').mockResolvedValue({ data: null, error: { message: 'unavailable' } } as never);
        return query;
      });
    }
    expect(await loadPublishedCaseStudy(db, published.slug)).toEqual({ ok: false });
    const html = renderToStaticMarkup(await Page(props()));
    expect(html).toContain('Could not load this customer story.');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Private draft');
    expect(html).not.toContain('application/ld+json');
    expect(console.error).toHaveBeenCalledWith('[customer-story] published story read failed', expect.anything());
  });
});
