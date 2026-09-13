import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { FEATURE_CATALOG } from '@/lib/constants/feature-catalog';
import { ROUTE_PLAN_LEVEL } from '@/lib/constants/plans';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A paid feature has to be refused by the SERVER, not only by the sidebar.
 *
 * The sidebar already refuses all 62 of them: `featureAccessByTier` returns
 * 'locked' for a family below the tier, and `NavEntry` then renders a padlock
 * and an upgrade prompt instead of a link. So the product tells a Free family
 * they do not have these features. On 2026-09-13, 24 of the 62 pages behind
 * that padlock did not check — they called `requireUserContext()` and rendered
 * — and the generic write path behind nine of them did not check either. The
 * URL was the whole bypass.
 *
 * That is the F7/F15 shape once more: an entitlement stated where the user can
 * see it and absent where it is enforced.
 */

const READ = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/** Comments do not enforce anything, and a JSDoc mentioning the guard is how a
 *  sweep like this quietly turns vacuous (it happened once already, in F11). */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function pageFor(href: string): string | null {
  const seg = href.replace(/^\//, '');
  for (const base of ['app/(app)', 'app']) {
    const p = path.join(base, seg, 'page.tsx');
    if (fs.existsSync(path.join(process.cwd(), p))) return p;
  }
  return null;
}

/** The page, plus every layout above it — either may hold the guard. */
function guardCarriers(page: string): string[] {
  const files = [page];
  let dir = path.dirname(page);
  while (dir && dir !== 'app' && dir !== 'app/(app)' && dir !== '.') {
    const layout = path.join(dir, 'layout.tsx');
    if (fs.existsSync(path.join(process.cwd(), layout))) files.push(layout);
    dir = path.dirname(dir);
  }
  return files;
}

const isGuarded = (page: string) =>
  guardCarriers(page).some((f) => /require(Feature|PlanLevel)\(/.test(stripComments(READ(f))));

describe('every paid feature is enforced on the server, not only in the nav', () => {
  // Derived from the catalog rather than a list, so adding a paid feature
  // without a guard fails here instead of shipping.
  const paidHrefs = [...new Set(
    FEATURE_CATALOG.filter((f) => f.href && (f.defaultTier === 'basic' || f.defaultTier === 'plus')).map((f) => f.href!),
  )].sort();

  it('has a page file for every paid feature href', () => {
    expect(paidHrefs.filter((h) => !pageFor(h))).toEqual([]);
  });

  it('guards every one of them', () => {
    const unguarded = paidHrefs.filter((h) => { const p = pageFor(h); return p && !isGuarded(p); });
    expect(unguarded).toEqual([]);
  });

  it('counts enough features that the sweep is actually sweeping', () => {
    // A resolution bug that silently matched nothing would pass the case above
    // with an empty list. 24 of these were unguarded when this was written.
    expect(paidHrefs.length).toBeGreaterThanOrEqual(60);
  });

  it('can tell a guarded page from an unguarded one', () => {
    // Proves the detector, not the pages: a file with no guard must fail it.
    const withoutGuard = 'app/(app)/dashboard/needs-you/page.tsx';
    expect(fs.existsSync(path.join(process.cwd(), withoutGuard))).toBe(true);
    expect(/require(Feature|PlanLevel)\(/.test(stripComments(READ(withoutGuard)))).toBe(false);
  });
});

describe('the documented route→level map cannot drift from what is enforced', () => {
  it('agrees with the catalog on every route they share', () => {
    // It disagreed on 19 of 55 when this was written, and three other documents
    // cited it as fact. It is derived now; this pins that it stays derived.
    const level = (t: string) => (t === 'plus' ? 2 : t === 'basic' ? 1 : 0);
    const catalog = new Map<string, number>();
    for (const f of FEATURE_CATALOG) {
      if (!f.href || f.defaultTier === 'off') continue;
      const seen = catalog.get(f.href);
      catalog.set(f.href, seen === undefined ? level(f.defaultTier) : Math.min(seen, level(f.defaultTier)));
    }
    const disagreements = [...catalog].filter(([href, lvl]) => ROUTE_PLAN_LEVEL[href] !== lvl).map(([href]) => href);
    expect(disagreements).toEqual([]);
  });

  it('keeps the routes that are not catalog features at all', () => {
    for (const href of ['/dashboard', '/dashboard/settings', '/dashboard/billing', '/dashboard/trust']) {
      expect(ROUTE_PLAN_LEVEL[href]).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The cases above read source, which is the right instrument for "does the
// guard exist". Whether the WRITE path refuses is a question about behaviour,
// so the rest of this file drives the real server action.
// ─────────────────────────────────────────────────────────────────────────────

type DB = SupabaseClient<Database>;
const FREE = 'family-free';
const PLUS = 'family-plus';

const state = vi.hoisted(() => ({ db: null as unknown, familyId: 'family-plus', failSubscriptionsRead: false }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => state.db,
  createServiceClient: () => state.db,
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: { familyId: state.familyId, role: 'parent', member: { id: 'member-1' } },
  }),
}));

const { createFamilyRecord, deleteFamilyRecord } = await import('@/lib/family/actions');

function failingSubscriptions(db: ReturnType<typeof createInMemorySupabase<DB>>): DB {
  const failing = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'single']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: new Error('subscriptions read failed') }).then(resolve);
    return chain;
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) =>
        state.failSubscriptionsRead && table === 'subscriptions' ? failing() : (target as DB).from(table as never);
    },
  }) as DB;
}

beforeEach(() => {
  state.failSubscriptionsRead = false;
  state.familyId = PLUS;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createInMemorySupabase<DB>();
  db.seed('families', [
    { id: FREE, name: 'Free household', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
    { id: PLUS, name: 'Plus household', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
  ]);
  db.seed('subscriptions', [{ family_id: PLUS, plan: 'plus', status: 'active' }]);
  state.db = failingSubscriptions(db);
});

const rows = (name: string) =>
  ((state.db as unknown as Record<string, unknown>).table as (n: string) => unknown[])(name);

describe('the generic family write path refuses a feature the family does not have', () => {
  it('refuses a Free family an automation rule, and writes nothing', async () => {
    state.familyId = FREE;

    const result = await createFamilyRecord('family_automation_rules', { name: 'Sunday meal plan', trigger_type: 'schedule' });

    expect(result).toMatchObject({ ok: false, error: 'That is not part of your plan.' });
    expect(rows('family_automation_rules')).toHaveLength(0);
  });

  it('lets a Family+ household write the same row', async () => {
    state.familyId = PLUS;

    const result = await createFamilyRecord('family_automation_rules', { name: 'Sunday meal plan', trigger_type: 'schedule' });

    expect(result).toMatchObject({ ok: true });
    expect(rows('family_automation_rules')).toHaveLength(1);
  });

  it('says something different when the plan cannot be read', async () => {
    // Not "that is not part of your plan" — that would tell a paying family to
    // buy what they already own because a subscription read blipped.
    state.familyId = PLUS;
    state.failSubscriptionsRead = true;

    const result = await createFamilyRecord('family_automation_rules', { name: 'Sunday meal plan', trigger_type: 'schedule' });

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/could not confirm your plan/i);
    expect(rows('family_automation_rules')).toHaveLength(0);
  });

  it('still lets a family delete a row after they drop a tier', async () => {
    // Deliberate: a gate on delete would strand a family's own data behind an
    // upgrade. Access is gated; ownership is not.
    state.familyId = PLUS;
    const created = await createFamilyRecord('family_automation_rules', { name: 'Sunday meal plan', trigger_type: 'schedule' });
    const id = (created as { id?: string }).id!;

    state.familyId = FREE;
    // The row belongs to the Plus family; what is under test is that the gate
    // does not run at all on delete, so the write path is reached.
    const result = await deleteFamilyRecord('family_automation_rules', id);

    expect(result).toMatchObject({ ok: true });
  });

  it('does not gate a table whose feature could not be identified', async () => {
    // family_milestones is rendered by /dashboard/planning and
    // /dashboard/grandparent-portal, neither of which is a catalog feature.
    // Guessing a feature for it would gate a surface nobody decided to gate.
    state.familyId = FREE;

    const result = await createFamilyRecord('family_milestones', { title: 'First day of school', milestone_date: '2026-09-01' });

    expect(result).toMatchObject({ ok: true });
  });
});
