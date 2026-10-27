// /dashboard/intelligence — what the page reads, and what it hands the browser.
//
// N2 / N9 — the page read `cohort_size` through RLS and passed every candidate,
// true size included, as props to the 'use client' IntelligenceModule: the
// exact per-band family count was in the RSC payload and printed in the badge,
// beside the noised detail. And the same RLS read is the door any member of a
// consenting family can use for every cohort, so the owner is asked to revoke
// the column from `authenticated` (see the summary); the page must not need
// it. The floor is re-checked with the service role instead, and only the
// noised count and a confidence derived from it go to the client.
//
// N8 — aggregates a failing cron left behind (families who withdrew still
// inside them) are not the network's answer past 36 hours.
//
// N13 — the reminders band counted the legacy `reminders` table, ignoring
// `is_done`, while the Reminders module writes `family_reminders`.
//
// N15 — the preview's dinner week and spend month were both-ends-inclusive:
// eight days and twenty-nine.
//
// The real page, rendered against the in-memory database; the RLS client
// refuses `cohort_size` on network_aggregates as the column grant would.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ours';
const holder = vi.hoisted(() => ({ rls: null as unknown, service: null as unknown, tz: 'UTC', role: 'parent', selects: [] as string[], grantApplied: true }));

/** The family's own (RLS) client: what the column grant leaves `authenticated`. */
function rlsClient(db: InMemorySupabase) {
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table);
        if (table !== 'network_aggregates') return builder;
        return new Proxy(builder as object, {
          get(b, key, r) {
            const value = Reflect.get(b, key, r);
            if (key !== 'select' || typeof value !== 'function') return value;
            return (columns: string, ...rest: unknown[]) => {
              holder.selects.push(columns);
              if (holder.grantApplied && /\bcohort_size\b|\*/.test(columns)) {
                // What PostgREST answers a column the role may not read.
                const refused = { data: null, error: { code: '42501', message: 'permission denied for table network_aggregates' }, count: null };
                const chain: Record<string, unknown> = {};
                for (const m of ['eq', 'gte', 'lte', 'in', 'order', 'limit', 'range']) chain[m] = () => chain;
                chain.then = (resolve: (v: unknown) => void) => resolve(refused);
                return chain;
              }
              return (value as (...a: unknown[]) => unknown).call(b, columns, ...rest);
            };
          },
        });
      };
    },
  });
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.rls, createServiceClient: () => holder.service }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'me' },
    active: { familyId: FAMILY, role: holder.role, member: { id: 'member', role: holder.role, user_id: 'me' }, family: { id: FAMILY, timezone: holder.tz } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/metric/automatic-capture-server', () => ({ loadAutomaticCaptureShare: async () => ({ ok: true, data: null }) }));
vi.mock('@/lib/network/benchmarks-server', async (original) => ({
  ...(await original<typeof import('@/lib/network/benchmarks-server')>()),
  benchmarksPageIsPublished: async () => false,
}));

const { default: IntelligencePage } = await import('@/app/(app)/dashboard/intelligence/page');
const { IntelligenceModule } = await import('@/components/modules/intelligence-module');

type El = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const child of node) elements(child, out); return out; }
  if (!isValidElement<Record<string, unknown>>(node)) return out;
  out.push(node);
  elements(node.props.children as ReactNode, out);
  return out;
}

async function moduleProps(): Promise<Record<string, unknown>> {
  const found = elements(await IntelligencePage()).find((e) => e.type === IntelligenceModule);
  if (!found) throw new Error('the intelligence module was not rendered');
  return found.props;
}

const bucket = async (labelKey: string) =>
  ((await moduleProps()).contribution as { labelKey: string; value: string }[]).find((b) => b.labelKey === labelKey)?.value;

let db: InMemorySupabase;
const NOW = new Date('2026-10-13T12:00:00Z'); // a Tuesday
const COHORT = 'kids:none|size:1–2';
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysFrom = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
const aggregate = (metric: string, value: string, count: number, cohortSize: number, computedAt = hoursAgo(9)) => ({
  id: `agg-${String(++seq).padStart(4, '0')}`, scope: 'benchmarks', cohort_key: COHORT, metric, value, count, cohort_size: cohortSize, computed_at: computedAt,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  db = createInMemorySupabase({ maxRows: 1000 });
  holder.service = db;
  holder.rls = rlsClient(db);
  holder.tz = 'UTC';
  holder.role = 'parent';
  holder.selects = [];
  holder.grantApplied = true;
  seq = 0;
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'member', family_id: FAMILY, role: 'parent', is_active: true, user_id: 'me', birthday: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('the true band size stays on the server', () => {
  beforeEach(() => {
    db.seed('network_aggregates', [
      aggregate('dinner_habit', 'often (4–5)', 49, 47),
      aggregate('reminders_per_week', 'none', 61, 59),           // under 3 × K truly, over it as shown
      aggregate('activities', 'none', 23, 12),                    // under the floor, whatever the table says
      aggregate('bedtime_band', '8–9pm', 88, 86, hoursAgo(72)),   // left by runs that kept failing
    ]);
  });

  it('renders the module without ever asking RLS for cohort_size', async () => {
    const props = await moduleProps();
    expect(props.candidates).toBeDefined();
    expect(holder.selects.length).toBeGreaterThan(0);
    for (const columns of holder.selects) expect(columns).not.toMatch(/cohort_size|\*/);
  });

  it('hands the client the noised count and a confidence derived from it — no true size, no stale or under-floor row', async () => {
    const candidates = (await moduleProps()).candidates as Record<string, unknown>[];
    expect(candidates.map((c) => c.id)).toEqual(['reminders_per_week:none', 'dinner_habit:often (4–5)']);
    for (const c of candidates) expect(c).not.toHaveProperty('cohortSize');
    const payload = JSON.stringify(candidates);
    expect(payload).not.toContain('47');
    expect(payload).not.toContain('59');
    expect(payload).toContain('49');
    // 59 true families is under 3 × 20; the label follows the 61 the family reads
    expect(candidates.find((c) => c.id === 'reminders_per_week:none')).toMatchObject({ count: 61, confidence: 'high' });
  });

  it('shows no insight, and keeps the consent controls, when the floor cannot be re-checked', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const props = await moduleProps();
    expect(props.candidates).toEqual([]);
  });

  it('before the column grant too, the client never receives a true size', async () => {
    holder.grantApplied = false;
    const candidates = (await moduleProps()).candidates as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c).not.toHaveProperty('cohortSize');
    expect(JSON.stringify(candidates)).not.toContain('47');
  });
});

describe('the consent preview is what the nightly aggregation would send', () => {
  // These are about the preview's own reads; the aggregate read is not under test.
  beforeEach(() => { holder.grantApplied = false; });

  it('counts the Reminders module\'s open reminders this week, and the legacy table\'s open ones', async () => {
    db.seed('family_reminders', [
      { id: 'r1', family_id: FAMILY, status: 'active', remind_at: daysFrom(1) + 'T09:00:00.000Z', snoozed_until: null },
      { id: 'r2', family_id: FAMILY, status: 'active', remind_at: daysFrom(2) + 'T09:00:00.000Z', snoozed_until: null },
      { id: 'r3', family_id: FAMILY, status: 'snoozed', remind_at: daysFrom(3) + 'T09:00:00.000Z', snoozed_until: daysFrom(4) + 'T09:00:00.000Z' },
      { id: 'r4', family_id: FAMILY, status: 'completed', remind_at: daysFrom(2) + 'T10:00:00.000Z', snoozed_until: null },
      { id: 'r5', family_id: FAMILY, status: 'snoozed', remind_at: daysFrom(5) + 'T09:00:00.000Z', snoozed_until: daysFrom(9) + 'T09:00:00.000Z' },
    ]);
    db.seed('reminders', [
      { id: 'l1', family_id: FAMILY, remind_at: daysFrom(3) + 'T08:00:00.000Z', is_done: false },
      { id: 'l2', family_id: FAMILY, remind_at: daysFrom(3) + 'T08:30:00.000Z', is_done: true },
    ]);
    // r1, r2, r3 and l1: four still to fire this week
    expect(await bucket('network.bucketRemindersPerWeek')).toBe('4–7');
  });

  it('reads seven days of dinners, today first — not eight', async () => {
    // Planned on days 2 to 7 from today: six dates, five of them inside the week.
    db.seed('meal_plans', [2, 3, 4, 5, 6, 7].map((d) => ({ id: `m${d}`, family_id: FAMILY, meal_type: 'dinner', plan_date: daysFrom(d) })));
    expect(await bucket('network.bucketDinnerPlanningHabit')).toBe('often (4–5)');
  });

  it('reads twenty-eight days of spending ending today — not twenty-nine', async () => {
    // 14 a day, every day from 28 days ago to today: 98 a week over the window.
    db.seed('transactions', Array.from({ length: 29 }, (_, i) => ({
      id: `t${String(i).padStart(3, '0')}`, family_id: FAMILY, amount: 14, type: 'expense', date: daysFrom(-i),
    })));
    expect(await bucket('network.bucketWeeklySpend')).toBe('under 100');
  });
});
