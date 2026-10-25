import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

// /admin/support and /admin/support-tickets count their tiles over every
// ticket, but each list is an unbounded read that PostgREST answers with at
// most 1,000 rows and no error, and its filters narrowed those rows: past them
// the Closed tile said 200 while ?status=closed said "No tickets match these
// filters", and "of N tickets" counted the list (coverage sweep round 9, class
// B). /admin/support reads its status filter with the server now; both lists
// say when they hold part of the queue. The REAL pages, in-memory database
// with PostgREST's 1,000-row cap.
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, describeConfiguredServiceKey: () => null }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/admin/ticket-status-control', () => ({ TicketStatusControl: () => null }));
vi.mock('@/components/admin/new-ticket-button', () => ({ NewTicketButton: () => null }));
vi.mock('@/components/admin/ticket-row-actions', () => ({ TicketRowActions: () => null }));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const ticket = (k: number, status: string): Row => ({
  id: `tkt-${pad(k)}`, ticket_number: `T-${pad(k)}`, subject: `Ticket ${k}`, description: null, category: 'general', priority: 'medium',
  status, tags: ['contact-form'], requester_name: null, requester_email: `t${k}@example.com`, assigned_agent_id: null, assigned_agent_name: null,
  // Higher k is newer, and more recently updated.
  created_at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(),
  updated_at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(),
});
/** 1,200 tickets: the 200 OLDEST closed, the 1,000 newest open. */
function seedPastTheList() {
  db.seed('support_tickets', [
    ...Array.from({ length: 200 }, (_, k) => ticket(k, 'closed')),
    ...Array.from({ length: 1000 }, (_, k) => ticket(200 + k, 'open')),
  ]);
}
async function renderSupport(params: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/(app)/admin/support/page');
  return renderServerPage(await Page({ searchParams: Promise.resolve(params) }));
}
async function renderTickets() {
  const { default: Page } = await import('@/app/(app)/admin/support-tickets/page');
  return renderServerPage(await Page({ searchParams: Promise.resolve({}) }));
}
const supportListed = (html: string) => (html.match(/<p class="font-medium">Ticket \d+<\/p>/g) ?? []).length;
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/support past the 1,000 tickets its list holds', () => {
  it('?status=closed lists the closed tickets the newest thousand left out, as the Closed tile counts them', async () => {
    seedPastTheList();
    const html = await renderSupport({ status: 'closed' });
    expect(statCardValue(html, m('adminSupport.closed'))).toBe('200');
    expect(supportListed(html)).toBe(200);
    expect(html).not.toContain('No tickets match these filters');
  });

  it('the unfiltered list says it holds the newest thousand of every ticket', async () => {
    seedPastTheList();
    const html = await renderSupport();
    expect(supportListed(html)).toBe(1000);
    expect(textOf(html)).toContain(m('adminCeiling.listAndFiltersShowTheNewest', { shown: '1,000', total: '1,200' }));
  });

  it('the ticket count that FAILS is the read-error state', async () => {
    seedPastTheList();
    h.db = withFaults(db, (table, calls) => (table === 'support_tickets' && head(calls) && !calls.some((c) => c.method === 'eq') ? { message: 'support_tickets unavailable' } : null));
    expect(await renderSupport()).toContain(SOURCE_MESSAGES['support.couldNotLoadSupportTickets']);
  });

  it('the control: a queue that fits the list says nothing about part of it', async () => {
    db.seed('support_tickets', [ticket(1, 'open'), ticket(2, 'closed')]);
    const html = await renderSupport();
    expect(supportListed(html)).toBe(2);
    expect(textOf(html)).not.toContain(m('adminCeiling.listAndFiltersShowTheNewest', { shown: '2', total: '2' }).slice(0, 30));
    expect(supportListed(await renderSupport({ status: 'closed' }))).toBe(1);
  });
});

describe('/admin/support-tickets past the 1,000 tickets its list holds', () => {
  it('the list says it holds the most recently updated thousand of every ticket', async () => {
    seedPastTheList();
    const html = await renderTickets();
    expect(textOf(html)).toContain(m('adminCeiling.listAndFiltersShowPart', { shown: '1,000', total: '1,200' }));
  });

  it('the control: a queue that fits the list says nothing about part of it', async () => {
    db.seed('support_tickets', [ticket(1, 'open'), ticket(2, 'closed')]);
    const html = await renderTickets();
    expect(textOf(html)).not.toContain(m('adminCeiling.listAndFiltersShowPart', { shown: '2', total: '2' }).slice(0, 30));
  });
});
