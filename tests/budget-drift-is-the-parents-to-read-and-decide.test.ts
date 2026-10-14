// N6 — a budget-drift signal is the household's spend against a budget's cap.
// /dashboard/family-signals rendered every signal to every member and its chips
// print "spent $X" and "cap $Y"; /dashboard/reasoning put the same signal in
// "What matters most right now?". Household money is a parent's or an adult's
// (lib/finance/household-money.ts, readsHouseholdMoney), and the proactive AI
// context already withholds drift from everyone else. And setSignalStatusAction
// had no role check, so a child could Dismiss the drift — a decision detection
// never reopens — and the parents would not see it again.
//
// The real pages are rendered inside the real LocaleProvider, and the real
// action is called, against the in-memory database.
//
// N9 (re-fix) — a scan deletes the active signals it no longer emits, and
// refreshSignalsAction runs it on the presser's own client. Once the held 0514
// (a non-manager reads only the transactions tagged to them) or 0509 (a guest
// reads no budgets or transactions) is applied, a child's or a guest's Refresh
// found no drift and deleted the parents'. Their Refresh now reads no money,
// writes no drift and retires nothing (SignalReach).
//
// N9-S1 — the same failure on a different write. The household's daily
// Operating Index (family_operating_index) and reasoning snapshot
// (reasoning_snapshots) are one row per family per day, upserted by whichever
// member's own client opened the Operating Index, the briefing, the Command
// Center or the reasoning page, or built the assistant's context. Under the
// 0514 stand-in a child's visit read none of the household's spending and no
// account below zero, and rewrote the parents' day as calm. Every visit still
// computes and shows its reader's index; only a parent's, an adult's or the
// system's keeps the day (SnapshotReach).
//
// N6 (missed sibling) — the reasoning page also answered "what's the next best
// move?" with the operating index's money counts ("1 account is below zero",
// "1 upcoming bill not covered") and "what can Bubaly handle?" with a card to
// pay a bill, for every reader. They are left out for anyone who does not read
// the household's money, as the drift is.
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { SliceEnv } from '@/lib/ai/context/policy';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { localeOrDefault } from '@/lib/i18n/locales';
import { readsHouseholdMoney } from '@/lib/finance/household-money';
import { managerOnlyText } from '@/lib/ai/context/manager-only';

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-sig';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = async () => ({ user: { id: `user-${h.role}` }, active: { familyId: 'fam-sig', role: h.role, member: { id: `m-${h.role}` }, family: { timezone: 'UTC', created_at: '2026-01-01T00:00:00Z' } } });
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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
// An async server component with its own read; the signal list is the subject.
vi.mock('@/components/metrics/signal-precision-card', () => ({ SignalPrecisionCard: () => null }));

const { default: FamilySignalsPage } = await import('@/app/(app)/dashboard/family-signals/page');
const { default: ReasoningPage } = await import('@/app/(app)/dashboard/reasoning/page');
const { default: FamilyOperatingIndexPage } = await import('@/app/(app)/dashboard/family-operating-index/page');
const { default: BriefingPage } = await import('@/app/(app)/dashboard/briefing/page');
const { default: CommandCenterPage } = await import('@/app/(app)/dashboard/command-center/page');
const { proactiveSlice } = await import('@/lib/ai/context/slices/proactive');
const { refreshSignalsAction, setSignalStatusAction } = await import('@/app/(app)/dashboard/family-signals/actions');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;

/**
 * The client as the held 0514 gives it to a member who does not read the
 * household's money: only the transactions tagged to them, and no account (0509
 * gives a guest no money at all, which reads the same here).
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

const DRIFT = 'Over budget on Groceries';
const FRICTION = '“Dishes” causes friction';

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db as unknown as DB;
  h.role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_signals', [
    {
      id: 'sig-drift', family_id: FAMILY, kind: 'budget_drift', subject_key: 'budget:groceries:2026-10-01', status: 'active', score: 92,
      title: DRIFT, detail: 'Spent $2,768.50 of your $2,000 monthly Groceries budget this period.',
      evidence: { category: 'Groceries', period: 'monthly', limit: 2000, spent: 2768.5, priorSpent: 0, overBy: 768.5, recurring: false },
      last_seen_at: '2026-10-14T00:00:00Z',
    },
    {
      id: 'sig-chore', family_id: FAMILY, kind: 'chore_conflict', subject_key: 'chore_conflict:c1', status: 'active', score: 70,
      title: FRICTION, detail: '2 rejected · 2 disputed · passed between 2 people. Rotate it or rethink it.',
      evidence: { rejected: 2, disputed: 2, members: 2, total: 4 }, last_seen_at: '2026-10-14T00:00:00Z',
    },
  ]);
});

describe('/dashboard/family-signals', () => {
  it.each(['parent', 'adult'])('a %s reads the drift, its spend and its cap', async (role) => {
    h.role = role;
    const html = paint(await FamilySignalsPage());
    expect(html).toContain(DRIFT);
    expect(html).toContain('$2,768.50');
    expect(html).toContain(FRICTION);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s reads the family\'s other patterns, and nothing of its money', async (role) => {
    h.role = role;
    const html = paint(await FamilySignalsPage());
    expect(html).toContain(FRICTION);
    expect(html).not.toContain(DRIFT);
    expect(html).not.toContain('2,768');
    expect(html).not.toContain('2,000');
  });
});

describe('a decision on budget drift is a parent\'s or an adult\'s', () => {
  it.each(['child', 'guest'])('a %s cannot dismiss or acknowledge it for the family', async (role) => {
    h.role = role;
    for (const status of ['dismissed', 'acknowledged'] as const) {
      const result = await setSignalStatusAction('sig-drift', status);
      expect(result.ok).toBe(false);
    }
    expect(db.table('family_signals').find((s) => s.id === 'sig-drift')!.status).toBe('active');
    // The family's other patterns are still everyone's to mark.
    expect(await setSignalStatusAction('sig-chore', 'acknowledged')).toEqual({ ok: true });
  });

  it('a parent can', async () => {
    expect(await setSignalStatusAction('sig-drift', 'dismissed')).toEqual({ ok: true });
    expect(db.table('family_signals').find((s) => s.id === 'sig-drift')!.status).toBe('dismissed');
  });
});

describe('/dashboard/reasoning', () => {
  it('puts the drift under "matters most" for a parent', async () => {
    const html = paint(await ReasoningPage());
    expect(html).toContain(DRIFT);
  });

  it.each(['child', 'guest'])('leaves it out for a %s, and keeps the household\'s own daily snapshot', async (role) => {
    await ReasoningPage();
    const household = db.table('reasoning_snapshots')[0].attention_count;

    h.role = role;
    const html = paint(await ReasoningPage());
    expect(html).not.toContain(DRIFT);
    expect(html).not.toContain('2,768');
    expect(html).toContain(FRICTION);
    expect(db.table('reasoning_snapshots')).toHaveLength(1);
    expect(db.table('reasoning_snapshots')[0].attention_count).toBe(household);
  });
});

describe('N9 — a Refresh by someone who does not read the household\'s money leaves its drift alone', () => {
  const drift = () => db.table('family_signals').find((s) => s.kind === 'budget_drift');
  const spend = (id: string, amount: number, memberId: string | null) => ({
    id, family_id: FAMILY, type: 'expense', category: 'Groceries', amount, date: '2026-10-05', member_id: memberId,
  });
  const pressRefreshAs = async (role: string) => {
    h.role = role;
    h.db = readsHouseholdMoney(role) ? db : narrowedTo(`m-${role}`);
    expect(await refreshSignalsAction()).toMatchObject({ ok: true });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    db.seed('budgets', [{ id: 'b-groceries', family_id: FAMILY, category: 'Groceries', amount: 2000, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  });
  afterEach(() => vi.useRealTimers());

  it.each(['child', 'teen', 'guest'])('a %s\'s Refresh, which sees none of the spending, keeps the parents\' active drift', async (role) => {
    db.seed('transactions', [spend('tx-household', 2768.5, null)]);
    const before = structuredClone(drift());

    await pressRefreshAs(role);

    expect(drift()).toEqual(before);
    expect(drift()!.status).toBe('active');
  });

  it('a child whose own tagged spending alone is over the cap does not rewrite the household\'s figure', async () => {
    db.seed('transactions', [spend('tx-household', 668.5, null), spend('tx-child', 2100, 'm-child')]);

    await pressRefreshAs('child');

    expect(drift()).toMatchObject({ id: 'sig-drift', status: 'active', evidence: { spent: 2768.5, limit: 2000 } });
    expect(drift()!.detail).toContain('$2,768.50');
  });

  it('a child\'s Refresh retires nothing; a parent\'s still retires what has stopped and keeps what has not', async () => {
    db.seed('transactions', [spend('tx-household', 2768.5, null)]);

    // No chore rows at all: the friction has stopped, or a narrower view cannot see them.
    await pressRefreshAs('child');
    expect(db.table('family_signals').map((s) => s.id).sort()).toEqual(['sig-chore', 'sig-drift']);

    await pressRefreshAs('parent');
    expect(db.table('family_signals').map((s) => s.id)).toEqual(['sig-drift']);
    expect(drift()).toMatchObject({ status: 'active', evidence: { spent: 2768.5, limit: 2000 } });
  });
});

describe('N9-S1 — a narrower visit is shown its own index and keeps the household\'s day as it was', () => {
  const NOW = new Date('2026-10-14T12:00:00Z');
  const index = () => db.table('family_operating_index');
  const reports = () => db.table('reasoning_snapshots');
  /** A visit by `role` on the client 0514 gives them. */
  const visitAs = async (role: string, page: () => Promise<unknown>) => {
    h.role = role;
    h.db = readsHouseholdMoney(role) ? db : narrowedTo(`m-${role}`);
    return page();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.seed('family_members', [
      { id: 'm-parent', family_id: FAMILY, display_name: 'Mum', role: 'parent', is_active: true },
      { id: 'm-child', family_id: FAMILY, display_name: 'Ava', role: 'child', is_active: true },
    ]);
    // $2,768.50 of household groceries on a $2,000 cap, and the checking
    // account $300 below zero: the parents' day is not a calm one.
    db.seed('budgets', [{ id: 'b-groceries', family_id: FAMILY, category: 'Groceries', amount: 2000, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
    db.seed('transactions', [{ id: 'tx-household', family_id: FAMILY, type: 'expense', category: 'Groceries', amount: 2768.5, date: '2026-10-05', member_id: null }]);
    db.seed('financial_accounts', [{ id: 'acct-checking', family_id: FAMILY, type: 'checking', balance: -300 }]);
  });
  afterEach(() => vi.useRealTimers());

  it.each(['parent', 'adult'])('a %s\'s visit keeps the day, as before: the overspend and the account below zero', async (role) => {
    await visitAs(role, () => FamilyOperatingIndexPage());
    expect(index()).toHaveLength(1);
    expect(index()[0]).toMatchObject({ family_id: FAMILY, as_of_date: '2026-10-14' });
    expect((index()[0].dimensions as Record<string, number>).financial).toBeLessThan(100);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s opening the Operating Index is shown their reading, and the parents\' row stays', async (role) => {
    await visitAs('parent', () => FamilyOperatingIndexPage());
    const household = structuredClone(index());

    const html = paint(await visitAs(role, () => FamilyOperatingIndexPage()));

    expect(html).toContain('Family Operating Index');
    expect(index()).toEqual(household);
  });

  it.each([
    ['the briefing', () => BriefingPage()],
    ['the Command Center', () => CommandCenterPage()],
  ])('nor does a child opening %s, which an adult\'s visit still keeps', async (_name, page) => {
    await visitAs('parent', () => FamilyOperatingIndexPage());
    const household = structuredClone(index());
    await visitAs('child', page);
    expect(index()).toEqual(household);

    db.replace('family_operating_index', []);
    await visitAs('adult', page);
    expect(index()).toHaveLength(1);
    expect((index()[0].dimensions as Record<string, number>).financial).toBeLessThan(100);
  });

  it('a child opening the reasoning page leaves both of the day\'s snapshots as they were', async () => {
    await visitAs('parent', () => ReasoningPage());
    const household = { index: structuredClone(index()), report: structuredClone(reports()) };
    expect(household.index).toHaveLength(1);
    expect(household.report).toHaveLength(1);

    const html = paint(await visitAs('child', () => ReasoningPage()));

    expect(html).toContain(FRICTION);
    expect(index()).toEqual(household.index);
    expect(reports()).toEqual(household.report);
  });

  it('nor does the assistant\'s context built for a child; built for a parent it still keeps the day', async () => {
    const build = (role: string) => {
      const canManage = readsHouseholdMoney(role);
      h.role = role;
      h.db = canManage ? db : narrowedTo(`m-${role}`);
      return proactiveSlice.load(
        { db: h.db, familyId: FAMILY } as unknown as ServiceScope,
        { tz: 'UTC', now: NOW, viewer: { canManage, role, memberId: `m-${role}` }, members: [], pageContext: null } as unknown as SliceEnv,
      );
    };

    expect((await build('child')).ok).toBe(true);
    expect(index()).toEqual([]);

    expect((await build('parent')).ok).toBe(true);
    expect(index()).toHaveLength(1);
    expect((index()[0].dimensions as Record<string, number>).financial).toBeLessThan(100);
  });
});

describe('N6 — the reasoning page leaves the household\'s money counts to the parents', () => {
  const BELOW_ZERO = '1 account is below zero';
  const UNCOVERED = '1 upcoming bill not covered';
  const PAY = 'Pay the water bill';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    // Read on today's database, before 0514: every member's client reads these.
    db.seed('financial_accounts', [{ id: 'acct-checking', family_id: FAMILY, type: 'checking', balance: -300 }]);
    db.seed('bills', [{ id: 'bill-water', family_id: FAMILY, title: 'Water', status: 'unpaid', autopay: false, due_date: '2026-10-20', amount: 80 }]);
    db.seed('autopilot_suggestions', [{ id: 'card-water', family_id: FAMILY, status: 'open', confidence: 95, urgency: 3, title: 'Water bill due Tuesday', action_label: PAY }]);
  });
  afterEach(() => vi.useRealTimers());

  it.each(['parent', 'adult'])('a %s reads them among the next moves and what Bubaly can handle', async (role) => {
    h.role = role;
    const html = paint(await ReasoningPage());
    for (const money of [BELOW_ZERO, UNCOVERED, PAY]) expect(html).toContain(money);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s reads the family\'s other answers, and none of them', async (role) => {
    h.role = role;
    const html = paint(await ReasoningPage());
    expect(html).toContain(FRICTION);
    for (const money of [BELOW_ZERO, UNCOVERED, PAY]) expect(html).not.toContain(money);
  });

  it('nor does the assistant\'s context built for a child, where "2 accounts" named no word the old rule knew', async () => {
    db.seed('financial_accounts', [{ id: 'acct-savings', family_id: FAMILY, type: 'savings', balance: -50 }]);
    const itemsFor = async (role: string) => {
      h.role = role;
      const canManage = readsHouseholdMoney(role);
      const built = await proactiveSlice.load(
        { db, familyId: FAMILY } as unknown as ServiceScope,
        { tz: 'UTC', now: new Date('2026-10-14T12:00:00Z'), viewer: { canManage, role, memberId: `m-${role}` }, members: [], pageContext: null } as unknown as SliceEnv,
      );
      if (!built.ok) throw new Error('the proactive slice did not build');
      const data = built.data.data as { report: { answers: { items: { title: string }[] }[] } };
      return data.report.answers.flatMap((a) => a.items.map((i) => i.title));
    };

    expect(await itemsFor('parent')).toContain('2 accounts are below zero');
    expect(await itemsFor('child')).not.toContain('2 accounts are below zero');
  });
});

// N6-R1 — and only them. The money rule was a list of words run over every
// item, and the orchestrator's items are worded from the family's calendar and
// its members' names: a member called Bill, "Bill's recital" overlapping swim
// practice, an "Insurance agent visit" with no location. A child lost every one
// of them. What is the household's money is now decided by where an item comes
// from: the operating index's money and paperwork moves by what they are, a
// money page by its link, and the words only for the items whose text an
// Autopilot card or an approval wrote.
describe('N6-R1 — a family\'s calendar and its people are not its money', () => {
  const CLASH = '“Bill\'s recital” overlaps “Swim practice”';
  const NO_LOCATION = '“Insurance agent visit” — no location';
  const BILLS_WEEK = 'Bill is carrying the most this week';
  const EXPIRING = '1 document expiring soon';
  const event = (id: string, title: string, assignee: string, startsAt: string, endsAt: string, category: string, location: string | null) => ({
    id, family_id: FAMILY, title, starts_at: startsAt, ends_at: endsAt, all_day: false, assignee_id: assignee, location, category,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    db.seed('family_members', [
      { id: 'm-bill', family_id: FAMILY, display_name: 'Bill', role: 'child', is_active: true },
      { id: 'm-parent', family_id: FAMILY, display_name: 'Mum', role: 'parent', is_active: true },
    ]);
    // Tomorrow Bill's recital overlaps his swim practice; on Friday Mum sees the
    // insurance agent somewhere nobody has written down.
    db.seed('calendar_events', [
      event('ev-recital', 'Bill\'s recital', 'm-bill', '2026-10-15T17:00:00Z', '2026-10-15T18:00:00Z', 'school', 'School hall'),
      event('ev-swim', 'Swim practice', 'm-bill', '2026-10-15T17:30:00Z', '2026-10-15T18:30:00Z', 'sports', 'Pool'),
      event('ev-agent', 'Insurance agent visit', 'm-parent', '2026-10-16T10:00:00Z', '2026-10-16T11:00:00Z', 'appointment', null),
    ]);
    // And three open chores: Bill is carrying the most this week.
    db.seed('chore_assignments', ['c1', 'c2', 'c3'].map((id) => ({
      id, family_id: FAMILY, member_id: 'm-bill', status: 'todo', due_at: '2026-10-18T12:00:00Z', created_at: '2026-10-13T12:00:00Z',
    })));
    // The household's paperwork is the parents' (the documents slice, §4).
    db.seed('documents', [{ id: 'doc-passport', family_id: FAMILY, title: 'Passport', category: 'passport', expires_at: '2026-10-30' }]);
  });
  afterEach(() => vi.useRealTimers());

  it.each(['parent', 'adult'])('a %s reads all of it', async (role) => {
    h.role = role;
    const html = paint(await ReasoningPage());
    for (const item of [CLASH, NO_LOCATION, BILLS_WEEK, EXPIRING]) expect(html).toContain(item);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s reads the clash, the missing place and who is stretched, and not the paperwork', async (role) => {
    h.role = role;
    const html = paint(await ReasoningPage());
    for (const item of [CLASH, NO_LOCATION, BILLS_WEEK]) expect(html).toContain(item);
    expect(html).not.toContain(EXPIRING);
  });

  // N6-R1-SLICE — the assistant's context composed the report for every
  // reader and then ran the money words over every item, so a child's
  // assistant lost the same three. It is now composed for its reader, as the
  // page is, and the words run only over what an Autopilot card or an approval
  // worded. The slice's `viewer` argument to loadReasoningReport is what keeps
  // the budget drift (sig-drift, seeded above for everyone; a signal, not an
  // index move, and linking to /dashboard/family-signals, which the words no
  // longer read) out of a child's report: without it, every other line here
  // still held and a child's context carried "Over budget on Groceries" with
  // its dollar amounts.
  it('the assistant\'s context built for a child carries them too, and still not the money, the drift or the paperwork', async () => {
    db.seed('financial_accounts', [
      { id: 'acct-checking', family_id: FAMILY, type: 'checking', balance: -300 },
      { id: 'acct-savings', family_id: FAMILY, type: 'savings', balance: -50 },
    ]);
    const itemsFor = async (role: string) => {
      h.role = role;
      const canManage = readsHouseholdMoney(role);
      const built = await proactiveSlice.load(
        { db, familyId: FAMILY } as unknown as ServiceScope,
        { tz: 'UTC', now: new Date('2026-10-14T12:00:00Z'), viewer: { canManage, role, memberId: `m-${role}` }, members: [], pageContext: null } as unknown as SliceEnv,
      );
      if (!built.ok) throw new Error('the proactive slice did not build');
      const data = built.data.data as { report: { answers: { items: { title: string }[] }[] } };
      return data.report.answers.flatMap((a) => a.items.map((i) => i.title));
    };

    // A parent's next moves are the accounts, the conflict and the load (three
    // to an answer); a child's are the conflict, the load and nothing behind
    // them, where the paperwork would otherwise be.
    const parent = await itemsFor('parent');
    for (const item of [CLASH, NO_LOCATION, BILLS_WEEK, '2 accounts are below zero', DRIFT]) expect(parent).toContain(item);

    const child = await itemsFor('child');
    for (const item of [CLASH, NO_LOCATION, BILLS_WEEK]) expect(child).toContain(item);
    for (const item of [EXPIRING, '2 accounts are below zero', DRIFT]) expect(child).not.toContain(item);
  });

  // N6-RE — the words an Autopilot card or an approval is read by matched only
  // the singular: "accounts", "documents" or "passports" passed. A card worded
  // in the plural is the managers' as the singular is; the family's calendar,
  // which the words no longer read, is still a child's.
  it('an Autopilot card worded in the plural is the managers\', and the clash is still a child\'s', async () => {
    const TOP_UP = 'Top up both savings accounts';
    db.seed('autopilot_suggestions', [{ id: 'card-top-up', family_id: FAMILY, status: 'open', confidence: 95, urgency: 3, title: 'Two balances are low', action_label: TOP_UP }]);

    h.role = 'parent';
    expect(paint(await ReasoningPage())).toContain(TOP_UP);
    for (const role of ['child', 'guest']) {
      h.role = role;
      const html = paint(await ReasoningPage());
      expect(html).not.toContain(TOP_UP);
      expect(html).toContain(CLASH);
      expect(paint(await FamilyOperatingIndexPage())).not.toContain(TOP_UP);
    }
  });
});

describe('N6-RE — the manager-only words, singular and plural', () => {
  it.each([
    '2 documents expiring soon', '3 accounts are below zero', 'Renew both passports', 'Review the family finances',
    'Financial check-in', 'Two budgets are over their cap', 'File the taxes', 'Cancel 2 subscriptions', 'Pay the bill', 'Pay the bills',
  ])('"%s" is the managers\'', (text) => {
    expect(managerOnlyText(text)).toBe(true);
  });

  it.each(['Swim practice', 'Taxi to the airport', '3 events need an owner'])('"%s" is not', (text) => {
    expect(managerOnlyText(text)).toBe(false);
  });
});
