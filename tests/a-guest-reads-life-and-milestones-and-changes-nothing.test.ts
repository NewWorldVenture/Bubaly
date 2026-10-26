// household-roles N4-R1-SIBLING, round 3 — a guest could still change Life &
// Milestones one control over from the launcher N4-R1 closed.
//
// A guest views the household and does not plan in it (0464). Round 2 refused
// one the launch, but setLifeEventStatusAction checked only that someone was
// signed in, so a guest completed, archived or reopened a parent's plan; the
// checklist tick was written straight from the browser, and life_event_plan_items
// asks only for membership; and the facts' add, pin, edit and remove went
// through saveFactAction, setFactPinnedAction and forgetFactAction, none of
// which asked the role. The module offered a guest every one of those controls.
//
// Driven here: the REAL actions against an in-memory database, and the REAL
// Life & Milestones and Family Memory modules through tests/helpers/module-harness.tsx,
// whose tick reaches the real action behind it.
import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const session = vi.hoisted(() => ({ role: 'parent' }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
// The server side: the session and the database.
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${session.role}`, email: null }, memberships: [],
    active: { familyId: h.app.familyId, role: session.role, member: { id: `member-${session.role}` }, family: { id: h.app.familyId, timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const messages = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages.SOURCE_MESSAGES, key, params) };
});

const { setLifeEventStatusAction } = await import('@/app/(app)/dashboard/life-event-actions');
const { setLifeEventItemDoneAction } = await import('@/app/(app)/dashboard/life-events/actions');
const { saveFactAction, setFactPinnedAction, forgetFactAction } = await import('@/app/(app)/dashboard/knowledge/actions');
const { LifeEventsModule } = await import('@/components/modules/life-events-module');
const { KnowledgeBaseModule } = await import('@/components/modules/knowledge-base-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const GUEST_REFUSED = 'Guests can view this, but not change it.';
const PLAN = 'plan-move';
const STEP = 'step-boxes';
const FACT = 'fact-pizza';
let db: InMemorySupabase;

function as(role: string) {
  session.role = role;
  (h.app as unknown as { role: string }).role = role;
  h.app.userId = `user-${role}`;
}

const plan = () => db.table('life_event_plans').find((row) => row.id === PLAN)!;
const step = () => db.table('life_event_plan_items').find((row) => row.id === STEP)!;
const fact = () => db.table('family_facts').find((row) => row.id === FACT);

const lifeEvents = () => render(h.hooks, createElement(LifeEventsModule as ComponentType));
const familyMemory = () => render(h.hooks, createElement(KnowledgeBaseModule as ComponentType));
/** The checklist's ticks: a button per step, carrying the step's title. */
const ticks = (tree: ReturnType<typeof lifeEvents>) => nodes(tree).filter((node) => node.type === 'button' && has(node, 'Order moving boxes'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC'; h.confirmAnswer = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('confirm', () => true);
  db.seed('family_members', ['parent', 'guest'].map((role) => ({
    id: `member-${role}`, family_id: h.app.familyId, user_id: `user-${role}`, role, display_name: role, is_active: true,
  })));
  // A parent's move, launched from its playbook, with one step left to do.
  db.seed('life_event_plans', [{
    id: PLAN, family_id: h.app.familyId, template_key: 'moving', title: 'Moving Home', status: 'active', event_date: '2026-12-01', created_by: 'user-parent',
  }]);
  db.seed('life_event_plan_items', [{
    id: STEP, family_id: h.app.familyId, plan_id: PLAN, title: 'Order moving boxes', category: 'buy', due_on: '2026-11-10', is_done: false, sort: 1, note: null,
  }]);
  // What the parent told Bubaly about the family.
  db.seed('family_facts', [{
    id: FACT, family_id: h.app.familyId, member_id: null, category: 'preference', label: 'Friday tradition', value: 'Pizza and a movie',
    notes: null, is_pinned: false, source: 'user', confidence: 100, created_by: 'user-parent', expires_at: null,
  }]);
  as('parent');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a guest is refused every Life & Milestones write, and nothing changes', () => {
  it.each(['completed', 'archived'] as const)('setLifeEventStatusAction(%s)', async (status) => {
    as('guest');
    expect(await setLifeEventStatusAction(PLAN, status)).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(plan().status).toBe('active');
  });

  it('setLifeEventStatusAction reopening a completed plan', async () => {
    plan().status = 'completed';
    as('guest');
    expect(await setLifeEventStatusAction(PLAN, 'active')).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(plan().status).toBe('completed');
  });

  it('setLifeEventItemDoneAction, the checklist tick', async () => {
    as('guest');
    expect(await setLifeEventItemDoneAction(STEP, true)).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(step().is_done).toBe(false);
  });

  it('saveFactAction, adding a fact and editing one', async () => {
    as('guest');
    expect(await saveFactAction(null, { label: 'Bedtime', value: '8pm', category: 'preference' })).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(await saveFactAction(FACT, { label: 'Friday tradition', value: 'Tacos' })).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(db.table('family_facts')).toHaveLength(1);
    expect(fact()).toMatchObject({ value: 'Pizza and a movie' });
  });

  it('setFactPinnedAction and forgetFactAction', async () => {
    as('guest');
    expect(await setFactPinnedAction(FACT, true)).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(await forgetFactAction(FACT)).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(fact()).toMatchObject({ is_pinned: false });
  });
});

describe('a parent still does each of them (control)', () => {
  it('completes, then reopens, the plan', async () => {
    expect(await setLifeEventStatusAction(PLAN, 'completed')).toEqual({ ok: true });
    expect(plan().status).toBe('completed');
    expect(await setLifeEventStatusAction(PLAN, 'active')).toEqual({ ok: true });
    expect(plan().status).toBe('active');
  });

  it('ticks the step, and a step of another family is not ticked', async () => {
    expect(await setLifeEventItemDoneAction(STEP, true)).toEqual({ ok: true });
    expect(step().is_done).toBe(true);
    db.seed('life_event_plan_items', [{ id: 'step-elsewhere', family_id: 'another-family', plan_id: 'plan-elsewhere', title: 'x', category: 'buy', is_done: false, sort: 1 }]);
    expect(await setLifeEventItemDoneAction('step-elsewhere', true)).toEqual({ ok: false, error: t('errors.thatChangeWasNotSaved') });
    expect(db.table('life_event_plan_items').find((row) => row.id === 'step-elsewhere')!.is_done).toBe(false);
  });

  it('adds, pins and removes a fact', async () => {
    expect(await saveFactAction(null, { label: 'Bedtime', value: '8pm', category: 'preference' })).toMatchObject({ ok: true });
    expect(db.table('family_facts')).toHaveLength(2);
    expect(await setFactPinnedAction(FACT, true)).toMatchObject({ ok: true });
    expect(fact()).toMatchObject({ is_pinned: true });
    expect(await forgetFactAction(FACT)).toMatchObject({ ok: true });
    expect(fact()).toBeUndefined();
  });
});

describe('Life & Milestones offers a guest nothing to change', () => {
  const controls = (tree: ReturnType<typeof lifeEvents>) => ({
    complete: allByName(tree, t('lifeEvents.complete')).length,
    archive: allByName(tree, t('lifeEvents.archive')).length,
    ticks: ticks(tree).length,
    add: allByName(tree, 'Add', 'button').length,
    pin: allByName(tree, t('dialogTitle.pin')).length,
    edit: allByName(tree, t('lifeEvents.edit')).length,
    remove: allByName(tree, t('lifeEvents.remove')).length,
  });

  it('a guest reads the plan, its checklist and the facts, with no Complete, Archive, tick, Add, Pin, Edit or Remove', () => {
    as('guest');
    const tree = lifeEvents();
    expect(has(tree, 'Moving Home')).toBe(true);
    expect(has(tree, 'Order moving boxes')).toBe(true);
    expect(has(tree, 'Pizza and a movie')).toBe(true);
    expect(controls(tree)).toEqual({ complete: 0, archive: 0, ticks: 0, add: 0, pin: 0, edit: 0, remove: 0 });
  });

  it('a guest is not offered Reopen on a completed plan', () => {
    plan().status = 'completed';
    as('guest');
    expect(allByName(lifeEvents(), t('lifeEvents.reopen'))).toHaveLength(0);
  });

  it('a parent is offered each, and the tick goes through the server action to the database (control)', async () => {
    const tree = lifeEvents();
    expect(controls(tree)).toEqual({ complete: 1, archive: 1, ticks: 1, add: 1, pin: 1, edit: 1, remove: 1 });
    await click(ticks(tree)[0]);
    expect(h.toasts.error).toEqual([]);
    expect(step().is_done).toBe(true);
    await click(byName(lifeEvents(), t('lifeEvents.archive')));
    expect(plan().status).toBe('archived');
  });
});

describe('Family Memory offers a guest nothing to change either', () => {
  const controls = (tree: ReturnType<typeof familyMemory>) => ({
    add: allByName(tree, new RegExp(t('knowledgeBase.addAFact'))).length,
    pin: allByName(tree, t('dialogTitle.pin')).length,
    edit: allByName(tree, t('knowledgeBase.edit')).length,
    remove: allByName(tree, t('knowledgeBase.remove')).length,
    copy: allByName(tree, t('knowledgeBase.copyValue')).length,
  });

  it('a guest reads the fact and may copy it, with no Add, Pin, Edit or Remove', () => {
    as('guest');
    const tree = familyMemory();
    expect(has(tree, 'Pizza and a movie')).toBe(true);
    expect(controls(tree)).toEqual({ add: 0, pin: 0, edit: 0, remove: 0, copy: 1 });
  });

  it('a parent is offered each (control)', () => {
    expect(controls(familyMemory())).toEqual({ add: 1, pin: 1, edit: 1, remove: 1, copy: 1 });
  });
});
