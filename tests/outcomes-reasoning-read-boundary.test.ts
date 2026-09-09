import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown, reasoning: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'me' }, active: { familyId: 'ours', member: { id: 'member' }, role: 'parent', family: { timezone: 'America/New_York', created_at: '2026-01-01' } } }) }));
vi.mock('@/lib/reasoning/context', () => ({ loadFamilyContext: holder.reasoning }));
vi.mock('@/components/analytics/activation-beacon', () => ({ ActivationBeacon: () => null }));
vi.mock('@/components/ui/states', () => ({ ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { default: Page } = await import('@/app/(app)/dashboard/outcomes/page');
let db: InMemorySupabase;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  holder.db = db;
  holder.reasoning.mockRejectedValue(new Error('Shared context failed'));
});
afterEach(() => vi.restoreAllMocks());

describe('Outcomes reasoning read boundary and selected launch destination', () => {
  it('renders a shared-context failure while keeping the actual selected outcome and its launch button usable', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ outcome: 'feed_family' }) }));
    expect(console.error).toHaveBeenCalledWith('[dashboard/outcomes] reasoning context read failed', expect.any(Error));
    expect(html).toContain('Relationship insights are temporarily unavailable');
    expect(html).toContain('Have Bubaly do it');
    const selected = html.match(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(selected).toContain('Feed the Family');
    expect(html).toContain('href="/dashboard/grocery"');
    expect(html).toContain('href="/dashboard/pantry"');
  });

  it('falls back to the first real outcome when a query parameter is unrecognized', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ outcome: 'not-a-workflow' }) }));
    expect(html.match(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/)?.[0]).toContain('Run Today');
  });

  it('shows count-read failure separately and does not manufacture an empty household', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      if (table === 'grocery_items') Object.defineProperty(query, 'then', { value: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: { message: 'Grocery read failed' } }).then(resolve) });
      return query;
    });
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Some household counts are unavailable');
    expect(html).toContain('Refresh this page');
    expect(html).toContain('Have Bubaly do it');
    expect(console.error).toHaveBeenCalledWith('[dashboard/outcomes] outcome counts read failed or incomplete', expect.objectContaining({ grocery: { message: 'Grocery read failed' } }));
  });
});
