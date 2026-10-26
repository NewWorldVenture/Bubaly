// Admin reach N17 — the SEO console's 'noindex' status had no public effect.
//
// saveSeoPage accepted status 'noindex' and the console offered it, but the only
// public reader (lib/marketing/seo.ts readSeoPage) takes `status = 'active'`
// rows — anon may read only those (0230) — and no route ever emitted
// `robots: { index: false }` for one. An operator who set a public path to
// noindex (say, a page making a retired claim) lost the custom title and
// description while the page stayed indexable and in the sitemap.
//
// The console stops offering it and the action refuses it, until a reader can
// honour it (that needs an owner-applied policy change; see the summary).
// Driven through the REAL page and the REAL action against the in-memory
// database. Negative control: before the fix both status selects offered
// noindex and a noindex save was stored.
import { createElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

const h = vi.hoisted(() => ({ db: null as unknown, gate: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: h.gate,
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw Object.assign(new Error(`Could not ${operation}.`), { digest: `${REFUSAL_DIGEST_PREFIX}invalid` }); },
}));

const { default: SeoPage } = await import('@/app/(app)/admin/marketing/seo/page');
const { SeoTabs } = await import('@/app/(app)/admin/marketing/seo/seo-tabs');
const { saveSeoPage } = await import('@/app/(app)/admin/marketing/actions');

let db: InMemorySupabase;
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}
/** Every tab panel the page hands its tab switcher, rendered (the switcher shows one at a time). */
async function panels(): Promise<string> {
  const find = (node: ReactNode): ReactNode[] => {
    if (Array.isArray(node)) return node.flatMap(find);
    if (!isValidElement<{ children?: ReactNode; tabs?: { panel: ReactNode }[] }>(node)) return [];
    if (node.type === SeoTabs) return (node.props.tabs ?? []).map((tab) => tab.panel);
    return find(node.props.children);
  };
  const found = find(await SeoPage());
  expect(found.length).toBeGreaterThan(0);
  return (await Promise.all(found.map((panel) => renderServerPage(panel)))).join('');
}
/** The option values of every status select, in order. */
function statusOptions(html: string): string[][] {
  return [...html.matchAll(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/g)]
    .map((m) => [...m[1].matchAll(/<option[^>]*value="([^"]*)"/g)].map((o) => o[1]));
}

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  db.seed('marketing_seo_keywords', []);
  db.seed('marketing_seo_pages', [{ id: 'seo-pricing', path: '/pricing', title: 'Pricing', meta_description: null, status: 'active', score: 80, metadata: {} }]);
  h.gate.mockReset().mockResolvedValue({ supabase: db, actorId: 'admin-1', actorEmail: 'admin@example.test' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the SEO console', () => {
  it('offers no noindex status for a page audit', async () => {
    const selects = statusOptions(await panels());
    // The row's edit form and the new-audit form (keyword selects use other values).
    const pageSelects = selects.filter((values) => values.includes('active'));
    expect(pageSelects).toHaveLength(2);
    for (const values of pageSelects) expect(values).toEqual(['active', 'archived']);
  });

  it('refuses a noindex save rather than storing a status the public site ignores', async () => {
    await expect(saveSeoPage(form({ path: '/features', title: 'Features', status: 'noindex' }))).rejects.toThrow();
    expect(db.table('marketing_seo_pages').map((row) => row.path)).toEqual(['/pricing']);
  });

  it('the control: an active save is stored, and an existing noindex row still shows what it holds', async () => {
    await saveSeoPage(form({ path: '/features', title: 'Features', status: 'active' }));
    expect(db.table('marketing_seo_pages').find((row) => row.path === '/features')).toMatchObject({ status: 'active' });
    db.table('marketing_seo_pages')[0].status = 'noindex';
    const rowSelect = statusOptions(await panels()).find((values) => values.includes('noindex'));
    expect(rowSelect).toEqual(['active', 'archived', 'noindex']);
  });
});
