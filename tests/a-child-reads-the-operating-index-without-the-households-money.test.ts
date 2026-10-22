// FOI-SIB / N6-S2 — the reasoning page leaves the household's money and
// paperwork to the parents (N6, N6-R1): "1 account is below zero", "1 upcoming
// bill not covered", an Autopilot card to pay a bill, "1 document expiring
// soon". The Operating Index page, open to every member, showed a child all of
// it — under "Do these next", in the financial dimension's summary ("0/1
// upcoming bills covered · 1 account below zero") and in the Chief of Staff's
// "What can be handled automatically today?".
//
// And its "Since yesterday" recap — on that page, the briefing and the Command
// Center — diffed whoever was reading against the household's row of the day
// before, a parent's reading. On the client the held 0514 gives a child (no
// accounts) the parents' account below zero read as "Cleared: 1 account is
// below zero", which nothing had cleared, and the household's composite read
// as the child's trend. The calm inbox listed the latest household row's money
// moves to every reader too.
//
// The real pages are rendered against the in-memory database, as the reader
// each role is.
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { CalmItem } from '@/lib/calm/inbox';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { localeOrDefault } from '@/lib/i18n/locales';
import { readsHouseholdMoney } from '@/lib/finance/household-money';

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-foi';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent', calm: [] as unknown[] }));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = async () => ({ user: { id: `user-${h.role}` }, active: { familyId: 'fam-foi', role: h.role, member: { id: `m-${h.role}` }, family: { timezone: 'UTC', created_at: '2026-01-01T00:00:00Z' } } });
  return { requireUserContext: ctx, requireFeature: ctx };
});
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault: toLocale } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
    getLocaleContext: async () => ({ locale: toLocale('en-US'), source: 'cookie', messages: getMessages('en-US') }),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
// The briefing's module loads the day in the browser; the recap it is handed
// from the server is what is under test, so it renders that alone.
vi.mock('@/components/modules/briefing-module', () => ({ BriefingModule: ({ recap }: { recap?: React.ReactNode }) => recap ?? null }));
// An async server component with its own reads; the Command Center's recap is the subject.
vi.mock('@/components/outcomes/outcomes-strip', () => ({ OutcomesStrip: () => null }));
// The calm inbox is built from what the page collected; record what that was.
vi.mock('@/lib/calm/inbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/calm/inbox')>();
  return { ...real, buildCalmInbox: (items: CalmItem[], opts?: Parameters<typeof real.buildCalmInbox>[1]) => { h.calm = items; return real.buildCalmInbox(items, opts); } };
});

const { default: FamilyOperatingIndexPage } = await import('@/app/(app)/dashboard/family-operating-index/page');
const { default: BriefingPage } = await import('@/app/(app)/dashboard/briefing/page');
const { default: CommandCenterPage } = await import('@/app/(app)/dashboard/command-center/page');
const { default: CalmPage } = await import('@/app/(app)/dashboard/calm/page');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;

/**
 * The client as the held 0514 gives it to a member who does not read the
 * household's money: only the transactions tagged to them, and no account.
 */
const narrowedTo = (memberId: string): DB => new Proxy(db, {
  get(target, property, receiver) {
    if (property !== 'from') return Reflect.get(target, property, receiver);
    return (table: string) => {
      const builder = target.from(table) as unknown as { select: (...args: unknown[]) => { eq: (column: string, value: unknown) => unknown } };
      if (table !== 'transactions' && table !== 'financial_accounts') return builder;
      const select = builder.select.bind(builder);
      builder.select = table === 'transactions'
        ? (...args) => select(...args).eq('member_id', memberId) as ReturnType<typeof select>
        : (...args) => select(...args).eq('id', 'no account reaches a non-manager under 0514') as ReturnType<typeof select>;
      return builder;
    };
  },
}) as unknown as DB;

function paint(tree: unknown): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  )).replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

const BELOW_ZERO = '1 account is below zero';
const UNCOVERED = '1 upcoming bill not covered';
const EXPIRING = '1 document expiring soon';
const PAY = 'Pay the water bill';
const FINANCIAL_SUMMARY = ['0/1 upcoming bills covered', '1 account below zero'];
const HELD_BACK = 'Bills, budgets and balances are for the adults who manage the family’s money.';
const CLASH = '“Bill\'s recital” overlaps “Swim practice”';
const NO_LOCATION = '“Insurance agent visit” — no location';
const BILLS_WEEK = 'Bill is carrying the most this week';
// FOI-FIN-SCORE — the financial dimension's score is covered-ratio − 12 per
// overspent budget − 25 per account below zero (lib/operating-index/score.ts):
// shown beside the withheld summary, it encoded the counts the summary hides.
// The label is the progress bar's name on the page; its number here is what the
// seeded day scores (0/1 bills covered, 1 account below zero).
const FINANCIAL_SCORE = /Financial preparedness: \d+ of 100/;
const PARENTS_FINANCIAL_SCORE = 'Financial preparedness: 0 of 100';

const event =(id: string, title: string, assignee: string, startsAt: string, endsAt: string, category: string, location: string | null) => ({
  id, family_id: FAMILY, title, starts_at: startsAt, ends_at: endsAt, all_day: false, assignee_id: assignee, location, category,
});

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db as unknown as DB;
  h.role = 'parent';
  h.calm = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('family_members', [
    { id: 'm-bill', family_id: FAMILY, display_name: 'Bill', role: 'child', is_active: true },
    { id: 'm-parent', family_id: FAMILY, display_name: 'Mum', role: 'parent', is_active: true },
  ]);
  // The household's money: the checking account $300 below zero, and the water
  // bill due next week without autopay, which an Autopilot card offers to pay.
  db.seed('financial_accounts', [{ id: 'acct-checking', family_id: FAMILY, type: 'checking', balance: -300 }]);
  db.seed('bills', [{ id: 'bill-water', family_id: FAMILY, title: 'Water', status: 'unpaid', autopay: false, due_date: '2026-10-20', amount: 80 }]);
  db.seed('autopilot_suggestions', [{ id: 'card-water', family_id: FAMILY, status: 'open', confidence: 95, urgency: 3, title: 'Water bill due Tuesday', action_label: PAY }]);
  // Its paperwork.
  db.seed('documents', [{ id: 'doc-passport', family_id: FAMILY, title: 'Passport', category: 'passport', expires_at: '2026-10-30' }]);
  // And the family's week, which is everyone's: Bill's recital overlaps his
  // swim practice tomorrow, Mum sees the insurance agent somewhere nobody has
  // written down, and Bill is carrying the most.
  db.seed('calendar_events', [
    event('ev-recital', 'Bill\'s recital', 'm-bill', '2026-10-15T17:00:00Z', '2026-10-15T18:00:00Z', 'school', 'School hall'),
    event('ev-swim', 'Swim practice', 'm-bill', '2026-10-15T17:30:00Z', '2026-10-15T18:30:00Z', 'sports', 'Pool'),
    event('ev-agent', 'Insurance agent visit', 'm-parent', '2026-10-16T10:00:00Z', '2026-10-16T11:00:00Z', 'appointment', null),
  ]);
  db.seed('chore_assignments', ['c1', 'c2', 'c3'].map((id) => ({
    id, family_id: FAMILY, member_id: 'm-bill', status: 'todo', due_at: '2026-10-18T12:00:00Z', created_at: '2026-10-13T12:00:00Z',
  })));
});
afterEach(() => vi.useRealTimers());

const index = () => db.table('family_operating_index');
/** A visit by `role` on the client the held 0514 gives them. */
const visitAs = async (role: string, page: () => Promise<unknown>) => {
  h.role = role;
  h.db = readsHouseholdMoney(role) ? db : narrowedTo(`m-${role}`);
  return paint(await page());
};

describe('the Operating Index page, on today\'s database', () => {
  it.each(['parent', 'adult'])('a %s reads the household\'s money, its paperwork and its week, and keeps the day', async (role) => {
    h.role = role;
    const html = paint(await FamilyOperatingIndexPage());
    for (const item of [BELOW_ZERO, UNCOVERED, EXPIRING, PAY, ...FINANCIAL_SUMMARY, CLASH, NO_LOCATION, BILLS_WEEK]) expect(html).toContain(item);
    expect(html).toContain(PARENTS_FINANCIAL_SCORE);
    expect(html).not.toContain(HELD_BACK);
    expect(index()).toHaveLength(1);
    expect((index()[0].suggestions as { id: string }[]).map((s) => s.id)).toEqual(expect.arrayContaining(['fix-negative-balances', 'cover-bills', 'renew-docs']));
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s reads the family\'s week, and none of its money or paperwork', async (role) => {
    h.role = role;
    const html = paint(await FamilyOperatingIndexPage());
    for (const item of [CLASH, NO_LOCATION, BILLS_WEEK]) expect(html).toContain(item);
    for (const money of [BELOW_ZERO, UNCOVERED, EXPIRING, PAY, ...FINANCIAL_SUMMARY]) expect(html).not.toContain(money);
    // Nor a count of the card it is not shown.
    expect(html).not.toContain('Autopilot can take off your plate');
    expect(html).toContain(HELD_BACK);
    // Nor the financial score beside the withheld summary, which encodes the
    // counts it hides; the other six dimensions and the composite are theirs.
    expect(html).not.toMatch(FINANCIAL_SCORE);
    expect(html).toContain('Financial preparedness');
    expect(html).toMatch(/Planning confidence: \d+ of 100/);
    expect(index()).toEqual([]);
  });
});

describe('"Since yesterday" is the household\'s day, read by the household', () => {
  /** The parents' reading of the 13th, kept by Mum's visit that day. */
  const parentsYesterday = async () => {
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    await visitAs('parent', () => FamilyOperatingIndexPage());
    expect(index().map((r) => r.as_of_date)).toEqual(['2026-10-13']);
    expect((index()[0].suggestions as { id: string }[]).map((s) => s.id)).toEqual(expect.arrayContaining(['fix-negative-balances', 'cover-bills']));
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
  };

  it.each([
    ['the Operating Index', () => FamilyOperatingIndexPage()],
    ['the briefing', () => BriefingPage()],
    ['the Command Center', () => CommandCenterPage()],
  ])('a child opening %s the next day is not told the parents\' account was cleared, nor given their trend', async (_name, page) => {
    await parentsYesterday();
    const household = structuredClone(index());

    const html = await visitAs('child', page);

    expect(html).not.toContain('Cleared:');
    expect(html).not.toContain(BELOW_ZERO);
    expect(html).not.toContain('Since yesterday');
    // No trend against the parents' composite, and no promise of one tomorrow.
    expect(html).not.toContain('vs. your last reading');
    expect(html).not.toContain('First reading');
    expect(index()).toEqual(household);
  });

  it('a parent the next day still reads what was cleared and the trend, and keeps the day', async () => {
    await parentsYesterday();
    db.replace('bills', db.table('bills').map((b) => ({ ...b, status: 'paid' })));

    const html = await visitAs('parent', () => FamilyOperatingIndexPage());

    expect(html).toContain('Since yesterday');
    expect(html).toContain(`Cleared: ${UNCOVERED}`);
    expect(html).toContain('vs. your last reading');
    expect(html).toContain(BELOW_ZERO);
    expect(index().map((r) => r.as_of_date).sort()).toEqual(['2026-10-13', '2026-10-14']);

    const brief = await visitAs('adult', () => BriefingPage());
    expect(brief).toContain(`Cleared: ${UNCOVERED}`);
  });
});

describe('the calm inbox lists the household\'s row of the day', () => {
  const calmTitles = async (role: string) => {
    await visitAs(role, () => CalmPage());
    return (h.calm as CalmItem[]).filter((i) => i.source === 'operating_index').map((i) => i.title);
  };

  it('to a child without its money or paperwork moves, and to a parent whole', async () => {
    await visitAs('parent', () => FamilyOperatingIndexPage());

    const parent = await calmTitles('parent');
    for (const move of [BELOW_ZERO, UNCOVERED, EXPIRING, BILLS_WEEK]) expect(parent).toContain(move);

    const child = await calmTitles('child');
    expect(child).toContain(BILLS_WEEK);
    for (const move of [BELOW_ZERO, UNCOVERED, EXPIRING]) expect(child).not.toContain(move);
  });
});
