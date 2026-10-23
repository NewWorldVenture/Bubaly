import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// /admin/marketplace/reports tallied its four tiles and its filter chips from
// the newest 300 reports and narrowed those 300 for each filter, so past them a
// report still open was in no tile and no chip, and "Needs action" said "No
// reports match this filter" while it waited (coverage sweep round 9, class B).
// The tiles and chips are head:true counts, each filter is read with the server,
// and the list says when it holds only part of its filter. The REAL page,
// in-memory database with PostgREST's 1,000-row cap.
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// The moderation control reaches for the router and a server action; it stands in as a marker.
vi.mock('@/components/admin/report-moderation', () => ({
  ReportModeration: ({ id }: { id: string }) => createElement('span', { 'data-moderates': id }),
}));

let db: InMemorySupabase;
const readError = SOURCE_MESSAGES['reports.couldNotLoadMarketplaceReports'];
const report = (k: number, status: string): Row => ({
  id: `rep-${pad(k)}`, listing_id: `lst-${k % 3}`, family_id: `fam-${k % 4}`, reason: 'spam', details: null, status, resolution: null,
  // Higher k is newer.
  created_at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(),
});
/** 350 reports: the 50 OLDEST still open, the 300 newest dismissed. */
function seedPastTheList() {
  db.seed('marketplace_reports', [
    ...Array.from({ length: 50 }, (_, k) => report(k, 'open')),
    ...Array.from({ length: 300 }, (_, k) => report(50 + k, 'dismissed')),
  ]);
  db.seed('marketplace_listings', [0, 1, 2].map((i) => ({ id: `lst-${i}`, title: `Listing ${i}`, status: 'active' })));
  db.seed('families', [0, 1, 2, 3].map((i) => ({ id: `fam-${i}`, name: `Family ${i}` })));
}

async function render(status?: string): Promise<string> {
  const { default: Page } = await import('@/app/(app)/admin/marketplace/reports/page');
  return renderServerPage(await Page({ searchParams: Promise.resolve(status ? { status } : {}) }));
}
const tile = (html: string, label: string) => new RegExp(`<div class="text-2xl font-bold">([^<]*)</div><div class="text-xs text-muted">${label}</div>`).exec(html)?.[1];
const chip = (html: string, label: string) => new RegExp(`${label} <span class="font-normal">([^<]*)</span>`).exec(html)?.[1];
const listed = (html: string) => (html.match(/data-moderates="/g) ?? []).length;
const note = (shown: number, total: number) => translate(SOURCE_MESSAGES, 'adminCeiling.listShowsTheNewest', { shown: shown.toLocaleString(), total: total.toLocaleString() });
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/marketplace/reports past the 300 it lists', () => {
  it('the tiles and chips count every report, and the list says it holds the newest 300', async () => {
    seedPastTheList();
    const html = await render();
    expect(html).not.toContain(readError);
    expect(tile(html, 'Needs action')).toBe('50');
    expect(tile(html, 'Dismissed')).toBe('300');
    expect(tile(html, 'Total')).toBe('350');
    expect(chip(html, 'Needs action')).toBe('50');
    expect(listed(html)).toBe(300);
    expect(textOf(html)).toContain(note(300, 350));
  });

  it('"Needs action" lists the open reports older than the newest 300, not "No reports match this filter"', async () => {
    seedPastTheList();
    const html = await render('needs_action');
    expect(listed(html)).toBe(50);
    expect(html).not.toContain('No reports match this filter.');
    expect(textOf(html)).not.toContain(note(50, 50).slice(0, 30));
  });

  it.each([
    ['the total', (calls: FaultCall[]) => head(calls) && !calls.some((c) => c.method === 'eq' || c.method === 'in')],
    ['the needs-action count', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'in')],
    ['the actioned count', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[1] === 'actioned')],
    ['the dismissed count', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[1] === 'dismissed')],
  ])('a count that FAILS (%s) is the read-error state, not a tally of the list', async (_, failing) => {
    seedPastTheList();
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'marketplace_reports' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'marketplace_reports unavailable' };
    });
    const html = await render();
    expect(faulted).toBe(1);
    expect(html).toContain(readError);
    expect(listed(html)).toBe(0);
  });

  it('the control: a queue that fits the list is counted the same, and says nothing about part of it', async () => {
    db.seed('marketplace_reports', [report(1, 'open'), report(2, 'reviewing'), report(3, 'actioned')]);
    db.seed('marketplace_listings', [{ id: 'lst-1', title: 'Listing 1', status: 'active' }]);
    db.seed('families', [{ id: 'fam-1', name: 'Family 1' }]);
    const html = await render();
    expect(tile(html, 'Needs action')).toBe('2');
    expect(tile(html, 'Actioned')).toBe('1');
    expect(tile(html, 'Total')).toBe('3');
    expect(listed(html)).toBe(3);
    expect(textOf(html)).not.toContain(note(3, 3).slice(0, 30));
    expect(listed(await render('actioned'))).toBe(1);
  });
});
