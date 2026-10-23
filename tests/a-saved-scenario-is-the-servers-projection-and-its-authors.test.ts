// household-roles N5, N6, N7, N12, N13 — the Family Digital Twin's saved
// scenarios and member profiles.
//
//   N12/N13  saveSimulationAction stored the browser's own verdict, weekly
//            hours and dimensions, and whatever member id it named, for any
//            role, a guest included. Every member's Saved list showed it.
//   N5       what it stored carried the household's money: the Cost line ("$X
//            of a $Y 'Sports' budget") and the cost and budget category typed
//            in, in a table every member reads (0147).
//   N7/N13   deleteSimulationAction checked only the family, so a child or a
//            guest deleted a parent's scenario, and the page put a Trash button
//            on every row for every viewer.
//   N6       the page read family_digital_twin_profiles with `*` for every
//            viewer: every member's metadata (the nightly scan's per-sibling
//            reliability scores), stress baseline and the parents' notes.
//
// The real actions and page, against an in-memory database.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, resolveServerChildren } from './helpers/render-server-page';

const FAMILY = 'family-1';
const OTHER_FAMILY = 'family-2';
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', userId: 'user-parent', selects: {} as Record<string, string[]> }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), redirect: () => { throw new Error('REDIRECT'); }, notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success() {}, error() {}, info() {}, toast() {} }) }));
// The client shell the page sits in (QuickAdd's journey analytics reads it).
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', selfMember: null, members: [], role: harness.role }) }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = () => ({
    user: { id: harness.userId, email: null },
    memberships: [],
    active: { familyId: FAMILY, role: harness.role, member: { id: `member-${harness.role}` }, family: { id: FAMILY, timezone: 'UTC' } },
  });
  return { requireUserContext: async () => ctx(), requireFeature: async () => ctx() };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});

const { saveSimulationAction, deleteSimulationAction, projectActivityAction } = await import('@/app/(app)/dashboard/family-digital-twin/actions');
const { default: TwinPage } = await import('@/app/(app)/dashboard/family-digital-twin/page');

/** What the browser can post: the action's arguments, whatever their declared shape. */
const post = saveSimulationAction as unknown as (...args: unknown[]) => ReturnType<typeof saveSimulationAction>;

let db: InMemorySupabase;
const as = (role: string, userId: string) => { harness.role = role; harness.userId = userId; };

const activity = (extra: Record<string, unknown> = {}) => ({
  memberId: 'member-child', memberName: 'Emma', activityName: 'Travel soccer',
  startsAt: '2026-10-17T10:00:00Z', durationMin: 90, sessionsPerWeek: 3, weeks: 4, travelMinEach: 30, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  harness.db = db;
  harness.selects = {};
  as('parent', 'user-parent');
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', display_name: 'Ana', is_active: true, color: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'member-child', family_id: FAMILY, user_id: 'user-child', role: 'child', display_name: 'Emma', is_active: true, color: null, created_at: '2026-01-02T00:00:00Z' },
    { id: 'member-guest', family_id: FAMILY, user_id: 'user-guest', role: 'guest', display_name: 'Grandpa', is_active: true, color: null, created_at: '2026-01-03T00:00:00Z' },
    { id: 'member-elsewhere', family_id: OTHER_FAMILY, user_id: 'user-elsewhere', role: 'child', display_name: 'Not ours', is_active: true, color: null, created_at: '2026-01-04T00:00:00Z' },
  ]);
  db.seed('budgets', [{ id: 'b-1', family_id: FAMILY, category: 'Sports', amount: 300, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('transactions', [{ id: 't-1', family_id: FAMILY, name: 'Cleats', amount: 250, category: 'Sports', date: '2026-10-02', type: 'expense', status: 'posted' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const saved = () => db.table('twin_simulations');

describe('a saved scenario is the server\'s own projection (N12, N13)', () => {
  it('keeps the verdict and hours the server projects, not the ones the browser posted', async () => {
    const projected = await projectActivityAction(activity());
    if (!projected.ok) throw new Error(projected.error);
    const forged = { verdict: 'clear', headline: 'Fits cleanly', weeklyHours: 0.5, dimensions: [] };
    expect(projected.data.weeklyHours).not.toBe(0.5);

    expect(await post(activity(), forged)).toEqual({ ok: true });

    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ verdict: projected.data.verdict, weekly_hours: projected.data.weeklyHours, created_by: 'user-parent' });
  });

  it('refuses a member who is not in this family, and keeps nothing', async () => {
    expect(await post(activity({ memberId: 'member-elsewhere', memberName: 'Not ours' }))).toEqual({ ok: false, error: 'That user is not an active family member.' });
    expect(saved()).toEqual([]);
  });

  it('refuses a guest, who views the household and does not write to it', async () => {
    as('guest', 'user-guest');
    const projected = await projectActivityAction(activity());
    expect(await post(activity(), projected.ok ? projected.data : undefined)).toEqual({ ok: false, error: 'Guests can view this, but not change it.' });
    expect(saved()).toEqual([]);
  });

  it('lets a child keep a scenario of their own', async () => {
    as('child', 'user-child');
    expect(await post(activity())).toEqual({ ok: true });
    expect(saved()[0]).toMatchObject({ created_by: 'user-child', member_id: 'member-child' });
  });
});

describe('a saved scenario keeps the household\'s money out (N5)', () => {
  it('a parent sees the Cost line, and it is not what the family\'s table keeps', async () => {
    const withCost = activity({ costDollars: 120, costCategory: 'Sports' });
    const projected = await projectActivityAction(withCost);
    if (!projected.ok) throw new Error(projected.error);
    const cost = projected.data.dimensions.find((d) => d.key === 'cost');
    expect(cost, 'the parent who asked sees the budget').toBeTruthy();

    // The browser posts back exactly what it was shown.
    expect(await post(withCost, projected.data)).toEqual({ ok: true });

    const row = saved()[0] as { input: Record<string, unknown>; dimensions: { key: string }[] };
    expect(row.dimensions.map((d) => d.key)).not.toContain('cost');
    expect(row.dimensions.length).toBeGreaterThan(0);
    expect(row.input).not.toHaveProperty('costDollars');
    expect(row.input).not.toHaveProperty('costCategory');
    expect(JSON.stringify(row)).not.toMatch(/\$300|Sports/);
  });
});

describe('a saved scenario is deleted by a manager or its author, never a guest (N7, N13)', () => {
  const seedScenario = (id: string, createdBy: string) => db.seed('twin_simulations', [{
    id, family_id: FAMILY, member_id: 'member-child', activity_name: `Scenario ${id}`, verdict: 'tight', weekly_hours: 4,
    input: {}, dimensions: [], created_by: createdBy, created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
  }]);

  it('a child cannot delete a scenario a parent saved', async () => {
    seedScenario('sim-parent', 'user-parent');
    as('child', 'user-child');
    expect(await deleteSimulationAction('sim-parent')).toEqual({ ok: false, error: 'Could not delete that simulation.' });
    expect(saved().map((s) => s.id)).toEqual(['sim-parent']);
  });

  it('a guest cannot delete one at all', async () => {
    seedScenario('sim-parent', 'user-parent');
    seedScenario('sim-guest', 'user-guest');
    as('guest', 'user-guest');
    expect(await deleteSimulationAction('sim-parent')).toEqual({ ok: false, error: 'Guests can view this, but not change it.' });
    expect(await deleteSimulationAction('sim-guest')).toEqual({ ok: false, error: 'Guests can view this, but not change it.' });
    expect(saved()).toHaveLength(2);
  });

  it('a child deletes their own, and a parent deletes anyone\'s', async () => {
    seedScenario('sim-child', 'user-child');
    seedScenario('sim-other-child', 'user-someone-else');
    as('child', 'user-child');
    expect(await deleteSimulationAction('sim-child')).toEqual({ ok: true });
    as('parent', 'user-parent');
    expect(await deleteSimulationAction('sim-other-child')).toEqual({ ok: true });
    expect(saved()).toEqual([]);
  });
});

describe('the twin page (N6, N7)', () => {
  /** Every column list the page asks of `table`. */
  function recordSelects(table: string) {
    const from = db.from.bind(db);
    db.from = ((name: string) => {
      const query = from(name);
      if (name !== table) return query;
      const select = query.select.bind(query);
      query.select = ((columns?: string, options?: never) => { (harness.selects[table] ??= []).push(columns ?? '*'); return select(columns, options); }) as typeof query.select;
      return query;
    }) as typeof db.from;
  }
  function find(tree: ReactNode, name: string): ReactElement<Record<string, unknown>> | null {
    if (Array.isArray(tree)) { for (const child of tree) { const hit = find(child, name); if (hit) return hit; } return null; }
    if (!isValidElement<Record<string, unknown>>(tree)) return null;
    if (typeof tree.type === 'function' && tree.type.name === name) return tree;
    return find(tree.props.children as ReactNode, name);
  }

  beforeEach(() => {
    db.seed('family_digital_twin_profiles', [{
      id: 'p-1', family_id: FAMILY, member_id: 'member-child', strengths: 'Loves reading', ai_insights: 'Best focus early',
      notes: 'Parents only: struggling after the move', stress_baseline: 72,
      metadata: { autopilot_traits: { reliabilityScore: 0.31, choreCompletionRate: 0.4 } },
    }]);
    db.seed('twin_simulations', [
      { id: 'sim-parent', family_id: FAMILY, member_id: 'member-child', activity_name: 'Piano', verdict: 'clear', weekly_hours: 2, input: {}, dimensions: [], created_by: 'user-parent', created_at: '2026-10-11T00:00:00Z' },
      { id: 'sim-child', family_id: FAMILY, member_id: 'member-child', activity_name: 'Chess club', verdict: 'tight', weekly_hours: 3, input: {}, dimensions: [], created_by: 'user-child', created_at: '2026-10-12T00:00:00Z' },
    ]);
  });

  it('reads only the profile columns its cards render, for every viewer', async () => {
    recordSelects('family_digital_twin_profiles');
    as('child', 'user-child');
    const markup = await renderServerPage(await TwinPage());
    expect(harness.selects.family_digital_twin_profiles).toEqual(['member_id, strengths, ai_insights']);
    expect(markup).toContain('Loves reading');
    expect(markup).not.toContain('struggling after the move');
  });

  it('offers Trash only on the scenarios the viewer may delete, and Save not to a guest', async () => {
    const deletes = (markup: string) => markup.split('aria-label="Delete scenario"').length - 1;
    as('child', 'user-child');
    expect(deletes(await renderServerPage(await TwinPage())), 'a child: their own scenario only').toBe(1);
    as('parent', 'user-parent');
    expect(deletes(await renderServerPage(await TwinPage())), 'a parent: every scenario').toBe(2);
    as('guest', 'user-guest');
    const guestTree = await resolveServerChildren(await TwinPage());
    expect(deletes(await renderServerPage(guestTree)), 'a guest: none').toBe(0);
    expect(find(guestTree, 'ActivityProjection')?.props.canSave).toBe(false);
    as('child', 'user-child');
    expect(find(await resolveServerChildren(await TwinPage()), 'ActivityProjection')?.props.canSave).toBe(true);
  });
});
