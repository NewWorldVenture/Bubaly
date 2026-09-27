// Page audit, /resources/benchmarks — an unpublished benchmarks page is a 404
// with nothing to say it was ever there.
//
// The page itself 404s while the admin publication flag is off, on purpose:
// "an unpublished page is indistinguishable from one that never existed". But
// its generateMetadata did not ask the flag, so production answered
// /resources/benchmarks with a 404 whose tab title and description still read
// "Household Benchmarks — how families like yours run the week" (crawl of
// www.bubaly.com, 2026-09-27). The metadata now asks the same question as the
// page.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const h = vi.hoisted(() => ({
  publication: { ok: true, published: false } as { ok: boolean; published?: boolean },
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('@/lib/network/benchmarks-server', () => ({
  readBenchmarksPublication: async () => h.publication,
  readBenchmarkAggregates: async () => ({ ok: true, rows: [] }),
}));
vi.mock('@/lib/marketing/seo', () => ({
  resolveMarketingMetadata: async (_path: string, fallback: { title: string }) => ({ title: fallback.title }),
}));

const { generateMetadata } = await import('@/app/(marketing)/resources/benchmarks/page');

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  h.publication = { ok: true, published: false };
});

describe('the benchmarks page title follows the publication flag', () => {
  it('is "Page not found", and not indexable, while unpublished', async () => {
    expect(await generateMetadata()).toEqual({ title: EN_US['publicPages.pageNotFound'], robots: { index: false } });
  });

  it('is "Page not found" when the page is not configured at all', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await generateMetadata()).title).toBe(EN_US['publicPages.pageNotFound']);
  });

  it('is the benchmarks title once published', async () => {
    h.publication = { ok: true, published: true };
    expect((await generateMetadata()).title).toBe(EN_US['benchmarksPage.metaTitle']);
  });

  it('keeps the benchmarks title when the flag could not be read (the page shows its own error card)', async () => {
    h.publication = { ok: false };
    expect((await generateMetadata()).title).toBe(EN_US['benchmarksPage.metaTitle']);
  });
});
