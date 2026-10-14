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
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { localeOrDefault } from '@/lib/i18n/locales';
import { readsHouseholdMoney } from '@/lib/finance/household-money';

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-sig';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: `user-${h.role}` }, active: { familyId: 'fam-sig', role: h.role, member: { id: `m-${h.role}` }, family: { timezone: 'UTC' } } }),
}));
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
const { refreshSignalsAction, setSignalStatusAction } = await import('@/app/(app)/dashboard/family-signals/actions');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;

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
  /**
   * The client as the held 0514 gives it to a member who does not read the
   * household's money: only the transactions tagged to them (0509 gives a guest
   * none at all, which reads the same here).
   */
  const narrowedTo = (memberId: string): DB => new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table) as unknown as { select: (...args: unknown[]) => { eq: (column: string, value: unknown) => unknown } };
        if (table !== 'transactions') return builder;
        const select = builder.select.bind(builder);
        builder.select = (...args) => select(...args).eq('member_id', memberId) as ReturnType<typeof select>;
        return builder;
      };
    },
  }) as unknown as DB;
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
