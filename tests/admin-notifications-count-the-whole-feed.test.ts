import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// /admin/notifications tallied "N unread", the All chip, each kind's chip and
// the last-24-hours rollup from the newest 300 notifications it lists, so past
// them each was the list's count presented as the feed's: 30 unread support
// tickets older than the 300 newest read "All caught up", had no chip, and
// were missing from the rollup (coverage sweep round 9, class B). The REAL page
// and list, in-memory database with PostgREST's 1,000-row cap.
const CAP = 1000;
const DIGEST_CEILING = 25_000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/app/(app)/admin/notifications-actions', () => ({ markAdminNotesReadAction: async () => ({ ok: true }) }));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const readError = SOURCE_MESSAGES['notifications.couldNotLoadAdminNotifications'];

const note = (k: number, kind: string, isRead: boolean, at: number): Row => ({
  id: `note-${pad(k)}`, kind, title: `Note ${k}`, body: null, url: null, is_read: isRead, created_at: new Date(at).toISOString(),
});
const NOW = Date.UTC(2026, 9, 22, 12);

/** 350 notifications of the last 24 hours: the 30 OLDEST are unread support tickets, then 320 read feedback items. */
function seedPastTheList() {
  db.seed('admin_notifications', [
    ...Array.from({ length: 30 }, (_, k) => note(k, 'support_ticket', false, NOW - 20 * 3_600_000 + k * 1000)),
    ...Array.from({ length: 320 }, (_, k) => note(30 + k, 'feedback_new', true, NOW - 10 * 3_600_000 + k * 1000)),
  ]);
}

async function render(): Promise<string> {
  const { default: AdminNotificationsPage } = await import('@/app/(app)/admin/notifications/page');
  return renderServerPage(await AdminNotificationsPage());
}
/** The count a chip shows beside its label. */
const chip = (html: string, label: string) => new RegExp(`${label} <span class="ml-1 font-normal">([^<]*)</span>`).exec(html)?.[1];
const listNote = (shown: number, total: number) => m('adminCeiling.listAndFiltersShowTheNewest', { shown: shown.toLocaleString(), total: total.toLocaleString() });
const listed = (html: string) => (html.match(/<p class="mt-0\.5 text-sm font-semibold text-fg">Note \d+<\/p>/g) ?? []).length;
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/admin/notifications past the 300 it lists', () => {
  it('the unread line, every chip and the 24-hour rollup count the whole feed, and the list says it is part of it', async () => {
    seedPastTheList();
    const html = await render();
    const page = textOf(html);
    expect(html).not.toContain(readError);
    expect(listed(html)).toBe(300);
    expect(page).toContain('30 unread.');
    expect(page).not.toContain('All caught up.');
    expect(chip(html, 'All')).toBe('350');
    expect(chip(html, 'Support ticket')).toBe('30');
    expect(page).toContain(SOURCE_MESSAGES['adminNotificationsList.markAllRead']);
    // The rollup names both kinds, with every one of the last 24 hours.
    expect(page).toContain('320 feedback items and 30 support tickets.');
    expect(page).toContain(listNote(300, 350));
  });

  it('past the rollup\'s ceiling the rollup alone says it is not shown; the counts stay exact', async () => {
    db.seed('admin_notifications', Array.from({ length: DIGEST_CEILING + 1 }, (_, k) => note(k, 'info', true, NOW - 3_600_000 + k)));
    const html = await render();
    expect(html).not.toContain(readError);
    expect(chip(html, 'All')).toBe((DIGEST_CEILING + 1).toLocaleString());
    const banner = textOf(html.slice(html.indexOf(m('adminCeiling.figuresNotShown', { n: DIGEST_CEILING.toLocaleString() }))));
    expect(banner.startsWith(`${m('adminCeiling.figuresNotShown', { n: DIGEST_CEILING.toLocaleString() })} ${m('adminNotifications.last24Hours')}`)).toBe(true);
    expect(html).not.toContain('updates to review');
  });

  it.each([
    ['the feed\'s count', (calls: FaultCall[]) => head(calls) && !calls.some((c) => c.method === 'eq')],
    ['the unread count', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'is_read')],
    ['one kind\'s count, support tickets', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[1] === 'support_ticket')],
    ['the rollup\'s rows', (calls: FaultCall[]) => calls.some((c) => c.method === 'gte')],
  ])('a read that FAILS (%s) is the read-error state, not a count of the list', async (_, failing) => {
    seedPastTheList();
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'admin_notifications' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'admin_notifications unavailable' };
    });
    const html = await render();
    expect(faulted).toBe(1);
    expect(html).toContain(readError);
    expect(listed(html)).toBe(0);
  });

  it('the control: a feed that fits the list is counted the same, and says nothing about part of it', async () => {
    db.seed('admin_notifications', [
      note(1, 'feedback_new', false, NOW - 3_600_000),
      note(2, 'feedback_new', true, NOW - 2 * 3_600_000),
      note(3, 'support_ticket', true, NOW - 3 * 86_400_000),
    ]);
    const html = await render();
    const page = textOf(html);
    expect(listed(html)).toBe(3);
    expect(page).toContain('1 unread.');
    expect(chip(html, 'All')).toBe('3');
    expect(chip(html, 'Support ticket')).toBe('1');
    expect(page).toContain('2 feedback items.');
    expect(page).not.toContain(listNote(3, 3).slice(0, 30));
  });
});
