import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

// admin-writers N9-S1. The customer view's date is families.updated_at, the
// family ROW's last edit (a rename, a time zone), and the view says so with
// `activityKnown: false`; the inactivity trigger and segment rule stopped
// reading it in N9. The Customer Health console did not: customerHealth turned
// it into "inactive 60d", took 25 points off the score and set churn risk past
// thirty days, so a paying Family+ family that uses the app daily but has not
// renamed itself in two months was listed among the customers needing
// attention, beside "Launch win-back", and counted in the Churn Risk tile.
// The real page, the real customer view, the in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));

const NOW = new Date('2026-10-12T10:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
let db: InMemorySupabase;

function family(id: string, opts: { subscribedDaysAgo: number; editedDaysAgo: number; status?: string }) {
  db.seed('families', [{ id, name: id, created_at: iso(400), updated_at: iso(opts.editedDaysAgo), closed_at: null }]);
  db.seed('family_members', [{ id: `m-${id}`, family_id: id, user_id: `u-${id}`, role: 'parent', is_active: true }]);
  db.seed('profiles', [{ id: `u-${id}`, email: `${id}@example.com` }]);
  db.seed('subscriptions', [{ id: `s-${id}`, family_id: id, plan: 'plus', status: opts.status ?? 'active', created_at: iso(opts.subscribedDaysAgo), current_period_end: null }]);
}

async function render(): Promise<string> {
  const { default: CustomerHealthPage } = await import('@/app/(app)/admin/marketing/health/page');
  return renderServerPage(await CustomerHealthPage());
}

/** The words of the table row for `familyId`. */
function row(html: string, familyId: string): string {
  const found = (html.match(/<tr[^>]*>.*?<\/tr>/g) ?? []).map(textOf).find((text) => text.startsWith(`${familyId} `));
  if (!found) throw new Error(`no row for ${familyId}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Customer Health does not read a family-row edit as activity', () => {
  it('a paying family whose row was last edited sixty days ago is healthy, not "inactive 60d" and churn risk', async () => {
    // Pays for Family+, uses the app — and has not renamed itself in sixty days.
    family('fam-daily', { subscribedDaysAgo: 200, editedDaysAgo: 60 });
    const html = await render();
    const text = row(html, 'fam-daily');
    // Lifecycle 75, one member +2, and no recency adjustment either way.
    expect(text, 'the family row\'s last edit was read as sixty days of inactivity').toMatch(/ active — 77 · Healthy —$/);
    expect(text).not.toContain('60d');
    expect(statCardValue(html, 'Churn Risk')).toBe('0');
    expect(statCardValue(html, 'Healthy')).toBe('1');
    expect(textOf(html)).toContain(SOURCE_MESSAGES['adminMarketingHealth.recencyNotScored']);
  });

  it('a lapsed family is still churn risk, on its lifecycle, and shows no inactivity the view cannot know', async () => {
    family('fam-lapsed', { subscribedDaysAgo: 200, editedDaysAgo: 1, status: 'past_due' });
    const html = await render();
    // Lifecycle 30, one member +2: at risk, and a churn risk for it.
    expect(row(html, 'fam-lapsed')).toMatch(/ lapsed — 32 · At risk ●$/);
    expect(statCardValue(html, 'Churn Risk')).toBe('1');
  });
});

describe('customerHealth with an activity signal it can trust (control)', () => {
  it('still scores recency and calls sixty silent days a churn risk', async () => {
    const { customerHealth } = await import('@/lib/marketing/health');
    const now = NOW.getTime();
    expect(customerHealth({ lifecycle: 'active', memberCount: 1, lastActivityAt: iso(60) }, now))
      .toEqual({ score: 52, band: 'monitor', churnRisk: true, inactiveDays: 60 });
    expect(customerHealth({ lifecycle: 'active', memberCount: 1, lastActivityAt: iso(60), activityKnown: false }, now))
      .toEqual({ score: 77, band: 'healthy', churnRisk: false, inactiveDays: null });
  });
});
