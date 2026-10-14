import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// Prep plans, through the REAL generator and the REAL Readiness page, against
// an in-memory database.
//
//   N8   a birthday or expiring-document plan is keyed by its source row, so a
//        dismissal of Mia's 2026 birthday hid every birthday she would have,
//        and a plan left active rolled into 2027 with 2026's ticked steps and
//        due dates; and a member removed from the household was still planned
//        a birthday every year.
//   N10  Readiness counted the unticked steps of DISMISSED plans — which the
//        Prep Plans page does not list, so nobody could tick them — as an
//        overdue "blocker" for good, and no plan was ever retired once its day
//        had passed.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = { user: { id: 'user-1' }, active: { familyId: 'f1', role: 'parent', member: { id: 'm-parent' }, family: { id: 'f1', timezone: 'UTC' } } };
  return { requireFeature: async () => ctx, requireUserContext: async () => ctx, effectivePlanLevel: async () => 2 };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 2 }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => SOURCE_MESSAGES[key] ?? key };
});
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement('a', { ...props, href }, children) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/dashboard/readiness' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { default: ReadinessPage } = await import('@/app/(app)/dashboard/readiness/page');

const TZ = 'UTC';
/** Before Mia's birthday on 1 November, and the day after it. */
const OCTOBER = new Date('2026-10-14T12:00:00Z');
const DAY_AFTER = new Date('2026-11-02T12:00:00Z');

let db: InMemorySupabase;
function household() {
  db = createInMemorySupabase({
    uniques: {
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
    defaults: { prep_plans: { status: 'active' }, prep_plan_steps: { is_done: false } },
  });
  h.db = db;
  db.seed('family_members', [{ id: 'm-mia', family_id: 'f1', display_name: 'Mia', birthday: '2015-11-01', is_active: true }]);
  return db as unknown as SupabaseClient<Database>;
}
const plan = (signalId: string) => db.table('prep_plans').find((row) => row.signal_id === signalId)!;
const steps = (planId: unknown) => db.table('prep_plan_steps').filter((s) => s.plan_id === planId);

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('N8: a decision belongs to the occurrence it was made on', () => {
  it('a birthday dismissed this year is planned again for next year', async () => {
    const sb = household();
    expect((await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER)).ok).toBe(true);
    expect(plan('m-mia')).toMatchObject({ target_date: '2026-11-01', status: 'active' });
    // The X on the card.
    plan('m-mia').status = 'dismissed';

    // The cron the day after the birthday.
    expect((await runPrepGeneration(sb, 'f1', null, TZ, DAY_AFTER)).ok).toBe(true);
    const next = plan('m-mia');
    expect(next).toMatchObject({ target_date: '2027-11-01', status: 'active' });
    expect(steps(next.id).length).toBeGreaterThan(0);
    expect(steps(next.id).every((s) => s.is_done === false && String(s.due_date).startsWith('2027-'))).toBe(true);
  });

  it('an active plan rolls into next year with its ladder started again, not last year\'s ticks and dates', async () => {
    const sb = household();
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    const id = plan('m-mia').id;
    for (const step of steps(id)) step.is_done = true;

    await runPrepGeneration(sb, 'f1', null, TZ, DAY_AFTER);
    expect(plan('m-mia')).toMatchObject({ id, target_date: '2027-11-01', status: 'active' });
    const ladder = steps(id);
    expect(ladder.length).toBe(4);
    expect(ladder.filter((s) => s.is_done)).toEqual([]);
    expect(ladder.map((s) => s.due_date).sort()).toEqual(['2027-10-11', '2027-10-18', '2027-10-25', '2027-10-31']);
  });

  it('the same occurrence keeps what the family ticked (regeneration is not a reset)', async () => {
    const sb = household();
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    const id = plan('m-mia').id;
    steps(id)[0].is_done = true;
    await runPrepGeneration(sb, 'f1', null, TZ, new Date('2026-10-20T12:00:00Z'));
    expect(steps(id).filter((s) => s.is_done)).toHaveLength(1);
  });

  it('a document renewed in place once it has expired is a new plan for the new expiry', async () => {
    const sb = household();
    db.seed('documents', [{ id: 'd-pass', family_id: 'f1', title: 'Passport', category: 'travel', is_secure: false, expires_at: '2026-10-18' }]);
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    plan('d-pass').status = 'dismissed';
    // Expired on the 18th; renewed on the same row, expiring again inside the horizon.
    db.table('documents')[0].expires_at = '2026-12-01';
    await runPrepGeneration(sb, 'f1', null, TZ, new Date('2026-10-20T12:00:00Z'));
    expect(plan('d-pass')).toMatchObject({ target_date: '2026-12-01', status: 'active' });
  });

  it('a member removed from the household is not planned a birthday', async () => {
    const sb = household();
    db.seed('family_members', [{ id: 'm-gone', family_id: 'f1', display_name: 'Former au pair', birthday: '1999-11-05', is_active: false }]);
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    expect(db.table('prep_plans').some((row) => row.signal_id === 'm-gone')).toBe(false);
    expect(plan('m-mia')).toBeDefined();
  });
});

// N8-R1 — the occurrence rule above read ANY date change on a birthday or a
// document as a new occurrence, including a date corrected before it came: the
// family's ticks were cleared and a dismissed plan came back. Only a date that
// has passed starts a new occurrence; a correction moves the plan.
describe('N8-R1: a date corrected before it comes is the same occurrence', () => {
  const passport = () => db.seed('documents', [{ id: 'd-pass', family_id: 'f1', title: 'Passport', category: 'travel', is_secure: false, expires_at: '2026-11-10' }]);
  const correctExpiry = (day: string) => { db.table('documents')[0].expires_at = day; };

  it('an expiry corrected from the 10th to the 12th keeps the ticked steps and takes the new due dates', async () => {
    const sb = household();
    passport();
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    const id = plan('d-pass').id;
    const before = steps(id).map((s) => String(s.due_date)).sort();
    expect(before.length).toBeGreaterThan(0);
    for (const step of steps(id)) step.is_done = true;

    correctExpiry('2026-11-12');
    expect((await runPrepGeneration(sb, 'f1', null, TZ, OCTOBER)).ok).toBe(true);
    expect(plan('d-pass')).toMatchObject({ id, target_date: '2026-11-12', status: 'active' });
    const ladder = steps(id);
    expect(ladder).toHaveLength(before.length);
    expect(ladder.filter((s) => s.is_done !== true)).toEqual([]);
    // Every due date moved the same two days the expiry did.
    const shifted = before.map((d) => new Date(Date.parse(`${d}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10));
    expect(ladder.map((s) => String(s.due_date)).sort()).toEqual(shifted);
  });

  it('a dismissed document plan stays dismissed when its expiry is corrected, and after the old date passes', async () => {
    const sb = household();
    passport();
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    plan('d-pass').status = 'dismissed';

    correctExpiry('2026-11-12');
    await runPrepGeneration(sb, 'f1', null, TZ, OCTOBER);
    expect(plan('d-pass')).toMatchObject({ target_date: '2026-11-12', status: 'dismissed' });

    // The 11th: the date first entered has passed, the corrected one has not.
    await runPrepGeneration(sb, 'f1', null, TZ, new Date('2026-11-11T12:00:00Z'));
    expect(plan('d-pass')).toMatchObject({ target_date: '2026-11-12', status: 'dismissed' });
  });

  it('a birthday corrected before it comes keeps both the dismissal and the ticks', async () => {
    const sb = household();
    await runPrepGeneration(sb, 'f1', 'parent-1', TZ, OCTOBER);
    const id = plan('m-mia').id;
    for (const step of steps(id)) step.is_done = true;
    // Mia's birthday is the 3rd, not the 1st.
    db.table('family_members')[0].birthday = '2015-11-03';
    await runPrepGeneration(sb, 'f1', null, TZ, OCTOBER);
    expect(plan('m-mia')).toMatchObject({ id, target_date: '2026-11-03', status: 'active' });
    expect(steps(id).filter((s) => s.is_done !== true)).toEqual([]);

    plan('m-mia').status = 'dismissed';
    db.table('family_members')[0].birthday = '2015-11-04';
    await runPrepGeneration(sb, 'f1', null, TZ, new Date('2026-10-20T12:00:00Z'));
    expect(plan('m-mia')).toMatchObject({ target_date: '2026-11-04', status: 'dismissed' });
  });
});

describe('N10: a plan nobody can see is not a blocker', () => {
  it('a plan whose day has passed is retired by the next generation', async () => {
    const sb = household();
    db.seed('prep_plans', [{ id: 'p-trip', family_id: 'f1', signal_kind: 'trip', signal_id: 'v-gone', title: 'Get ready: Lake', target_date: '2026-10-01', urgency: 'now', status: 'active' }]);
    expect((await runPrepGeneration(sb, 'f1', null, TZ, OCTOBER)).ok).toBe(true);
    expect(plan('v-gone').status).toBe('done');
  });

  it('Readiness counts only the overdue steps of the plans the Prep Plans page shows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OCTOBER);
    household();
    db.seed('prep_plans', [
      { id: 'p-dismissed', family_id: 'f1', signal_kind: 'trip', signal_id: 'v-1', title: 'Get ready: Camp', target_date: '2026-10-20', urgency: 'now', status: 'dismissed' },
      { id: 'p-active', family_id: 'f1', signal_kind: 'trip', signal_id: 'v-2', title: 'Get ready: Beach', target_date: '2026-10-25', urgency: 'now', status: 'active' },
    ]);
    db.seed('prep_plan_steps', [
      { id: 's1', family_id: 'f1', plan_id: 'p-dismissed', label: 'Check passports', due_date: '2026-10-01', is_done: false, lead_days: 19, sort_order: 0 },
      { id: 's2', family_id: 'f1', plan_id: 'p-dismissed', label: 'Pet care', due_date: '2026-10-06', is_done: false, lead_days: 14, sort_order: 1 },
      { id: 's3', family_id: 'f1', plan_id: 'p-active', label: 'Check passports', due_date: '2026-10-05', is_done: false, lead_days: 20, sort_order: 0 },
    ]);
    db.seed('family_members', [{ id: 'm-parent', family_id: 'f1', display_name: 'Pat', is_active: true }]);
    const html = renderToStaticMarkup(await ReadinessPage());
    expect(html).toMatch(/\b1 prep step overdue/);
    expect(html).not.toMatch(/\b3 prep steps overdue/);
  });

  it('and no blocker at all when the only overdue steps are a dismissed plan\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OCTOBER);
    household();
    db.seed('prep_plans', [{ id: 'p-dismissed', family_id: 'f1', signal_kind: 'trip', signal_id: 'v-1', title: 'Get ready: Camp', target_date: '2026-10-20', urgency: 'now', status: 'dismissed' }]);
    db.seed('prep_plan_steps', [{ id: 's1', family_id: 'f1', plan_id: 'p-dismissed', label: 'Check passports', due_date: '2026-10-01', is_done: false, lead_days: 19, sort_order: 0 }]);
    db.seed('family_members', [{ id: 'm-parent', family_id: 'f1', display_name: 'Pat', is_active: true }]);
    const html = renderToStaticMarkup(await ReadinessPage());
    expect(html).not.toMatch(/prep steps? overdue/);
    expect(html).toContain('Prep is on schedule');
  });
});
