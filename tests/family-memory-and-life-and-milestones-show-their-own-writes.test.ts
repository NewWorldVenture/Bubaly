// Family Memory (/dashboard/knowledge) and Life & Milestones
// (/dashboard/life-events) never showed their own writes.
//
// `family_facts`, `life_event_plans` and `life_event_plan_items` are not in the
// realtime publication, so `useRealtimeQuery` opens no channel for them
// (lib/realtime/published-tables.ts) and their lists change only when the
// component re-reads. Every write on both pages goes through a server action
// whose `revalidatePath` re-renders the server tree, which does not re-run a
// client component's fetcher. Neither module ever re-read, so:
//   - "Saved to family memory" was toasted over a list that did not change; an
//     edited fact kept its old value; a removed fact stayed, and removing it
//     again failed; Pin showed nothing, and the next press sent the same value
//     again, so a fact could not be unpinned without a reload;
//   - a playbook started from Life & Milestones did not appear, and its "Coming
//     up" card still offered to start it, so the natural next press filed a
//     second plan with a second set of to-dos and reminders;
//   - a checklist tick never showed, and the next tap sent `is_done = true`
//     again from the stale row; Complete and Archive left the plan as it was.
//
// Driven here: the REAL server actions against an in-memory database, and the
// REAL modules through tests/helpers/module-harness.tsx, whose realtime hook
// changes the screen only when the component asks, which is the real hook's
// behaviour for an unpublished table.
import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { REALTIME_TABLES } from '@/lib/realtime/published-tables';
import type { LifeEventSuggestion } from '@/lib/life-events/detect';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, change, click, form, has, nodes, render, submit, type Node } from './helpers/module-harness';
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
// The server side: the session and the database. `revalidatePath` does what it
// does to a client component's own read in the browser: nothing.
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

const { LifeEventsModule } = await import('@/components/modules/life-events-module');
const { KnowledgeBaseModule } = await import('@/components/modules/knowledge-base-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const PLAN = 'plan-move';
const STEP = 'step-boxes';
const FACT = 'fact-pizza';
let db: InMemorySupabase;

const fact = (id = FACT) => db.table('family_facts').find((row) => row.id === id);
const plan = () => db.table('life_event_plans').find((row) => row.id === PLAN)!;
const step = () => db.table('life_event_plan_items').find((row) => row.id === STEP)!;

const familyMemory = () => render(h.hooks, createElement(KnowledgeBaseModule as ComponentType));
const lifeEvents = (props: { suggestions?: LifeEventSuggestion[] } = {}) =>
  render(h.hooks, createElement(LifeEventsModule as ComponentType<typeof props>, props));

/** An input by its placeholder, in the open form. */
const field = (tree: ReactNode, placeholder: string): Node => {
  const found = nodes(tree).find((node) => (node.type === 'input' || node.type === 'textarea') && node.props.placeholder === placeholder);
  if (!found) throw new Error(`no field with placeholder ${placeholder}`);
  return found;
};
/** The checklist's ticks: a button per step, carrying the step's title. */
const ticks = (tree: ReactNode) => nodes(tree).filter((node) => node.type === 'button' && has(node, 'Order moving boxes'));
/** A control inside the open dialog (the start dialog repeats "Start playbook"). */
const inDialog = (tree: ReactNode, name: string) => byName(nodes(tree).filter((node) => node.props.role === 'dialog').at(-1)!, name);

const NEW_BABY: LifeEventSuggestion = {
  templateKey: 'new_baby', title: 'New Baby', reason: 'A baby is on the way.', reasonKey: 'lifeEvents.newBabyOnTheWay',
  reasonParams: {}, eventDate: null, score: 80,
} as LifeEventSuggestion;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
  resetHookSlots(h.hooks);
  // The column defaults 0145 declares: a plan the launcher inserts leaves its
  // status to the database, which starts it 'active'.
  db = createInMemorySupabase({ defaults: { life_event_plans: { status: 'active' }, life_event_plan_items: { is_done: false } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC'; h.confirmAnswer = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('confirm', () => true);
  session.role = 'parent';
  (h.app as unknown as { role: string }).role = 'parent';
  h.app.userId = 'user-parent';
  db.seed('family_members', [{
    id: 'member-parent', family_id: h.app.familyId, user_id: 'user-parent', role: 'parent', display_name: 'Ada', is_active: true,
  }]);
  // A move under way, with one step left to do.
  db.seed('life_event_plans', [{
    id: PLAN, family_id: h.app.familyId, template_key: 'moving', title: 'Moving Home', status: 'active', event_date: '2026-12-01', created_by: 'user-parent',
  }]);
  db.seed('life_event_plan_items', [{
    id: STEP, family_id: h.app.familyId, plan_id: PLAN, title: 'Order moving boxes', category: 'buy', due_on: '2026-11-10', is_done: false, sort: 1, note: null,
  }]);
  // What the parent told Bubaly about the family.
  db.seed('family_facts', [{
    id: FACT, family_id: h.app.familyId, member_id: null, category: 'preference', label: 'Friday tradition', value: 'Pizza and a movie',
    notes: null, is_pinned: false, source: 'user', confidence: 100, created_by: 'user-parent', expires_at: null, updated_at: '2026-10-01T12:00:00Z',
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the premise: nothing streams these tables to the page', () => {
  it.each(['family_facts', 'life_event_plans', 'life_event_plan_items'])('%s is not in the realtime publication', (table) => {
    expect(REALTIME_TABLES.has(table)).toBe(false);
  });
});

describe('Family Memory shows what its own writes changed', () => {
  it('a fact added from the form is on the list', async () => {
    await click(byName(familyMemory(), new RegExp(t('knowledgeBase.addAFact'))));
    change(field(familyMemory(), t('knowledgeBase.eGShoeSizeAllergyPediatrician')), 'Bedtime');
    change(field(familyMemory(), t('knowledgeBase.eGUs2PeanutsDr')), '8pm on school nights');
    await submit(form(familyMemory()));

    expect(h.toasts.error).toEqual([]);
    expect(db.table('family_facts').some((row) => row.value === '8pm on school nights')).toBe(true);
    expect(has(familyMemory(), '8pm on school nights')).toBe(true);
  });

  it('an edited fact shows its new value', async () => {
    await click(byName(familyMemory(), t('knowledgeBase.edit')));
    change(field(familyMemory(), t('knowledgeBase.eGUs2PeanutsDr')), 'Tacos and a board game');
    await submit(form(familyMemory()));

    expect(fact()).toMatchObject({ value: 'Tacos and a board game' });
    const tree = familyMemory();
    expect(has(tree, 'Tacos and a board game')).toBe(true);
    expect(has(tree, 'Pizza and a movie')).toBe(false);
  });

  it('a pinned fact shows as pinned, and the next press unpins it', async () => {
    await click(byName(familyMemory(), t('dialogTitle.pin')));
    expect(fact()).toMatchObject({ is_pinned: true });
    const pinned = familyMemory();
    expect(allByName(pinned, t('dialogTitle.unpin'))).toHaveLength(1);

    await click(byName(pinned, t('dialogTitle.unpin')));
    expect(fact()).toMatchObject({ is_pinned: false });
    expect(allByName(familyMemory(), t('dialogTitle.pin'))).toHaveLength(1);
  });

  it('a removed fact leaves the list', async () => {
    await click(byName(familyMemory(), t('knowledgeBase.remove')));
    expect(fact()).toBeUndefined();
    expect(h.toasts.success).toContain(t('knowledgeBaseModule.removed'));
    expect(has(familyMemory(), 'Pizza and a movie')).toBe(false);
  });
});

describe('Life & Milestones shows what its own writes changed', () => {
  it('a ticked step shows as done, and the next tap unticks it', async () => {
    await click(ticks(lifeEvents())[0]);
    expect(step().is_done).toBe(true);
    const ticked = lifeEvents();
    expect(has(ticked, '1/1 done')).toBe(true);

    await click(ticks(ticked)[0]);
    expect(step().is_done).toBe(false);
    expect(has(lifeEvents(), '0/1 done')).toBe(true);
  });

  it('a completed plan offers Reopen, and an archived one leaves the list', async () => {
    await click(byName(lifeEvents(), t('lifeEvents.complete')));
    expect(plan().status).toBe('completed');
    const completed = lifeEvents();
    expect(allByName(completed, t('lifeEvents.complete'))).toHaveLength(0);
    expect(allByName(completed, t('lifeEvents.reopen'))).toHaveLength(1);

    await click(byName(completed, t('lifeEvents.archive')));
    expect(plan().status).toBe('archived');
    const archived = lifeEvents();
    expect(allByName(archived, t('lifeEvents.archive'))).toHaveLength(0);
    expect(has(archived, '0/1 done')).toBe(false);
  });

  it('a playbook started from its card is on the list, with its checklist', async () => {
    await click(byName(lifeEvents(), /New Baby/, 'button'));
    await click(inDialog(lifeEvents(), t('lifeEvents.startPlaybook')));

    expect(h.toasts.error).toEqual([]);
    const started = db.table('life_event_plans').filter((row) => row.template_key === 'new_baby');
    expect(started).toHaveLength(1);
    const steps = db.table('life_event_plan_items').filter((row) => row.plan_id === started[0].id).length;
    expect(steps).toBeGreaterThan(0);
    expect(has(lifeEvents(), `0/${steps} done`)).toBe(true);
  });

  it('a playbook started from "Coming up" is no longer offered there', async () => {
    expect(has(lifeEvents({ suggestions: [NEW_BABY] }), t('lifeEvents.comingUp'))).toBe(true);
    const card = nodes(lifeEvents({ suggestions: [NEW_BABY] })).filter((node) => node.type === 'button' && has(node, t('lifeEvents.startPlaybook')));
    expect(card).toHaveLength(1);
    await click(card[0]);
    await click(inDialog(lifeEvents({ suggestions: [NEW_BABY] }), t('lifeEvents.startPlaybook')));

    expect(db.table('life_event_plans').filter((row) => row.template_key === 'new_baby')).toHaveLength(1);
    const after = lifeEvents({ suggestions: [NEW_BABY] });
    expect(has(after, t('lifeEvents.comingUp'))).toBe(false);
    expect(nodes(after).filter((node) => node.type === 'button' && has(node, t('lifeEvents.startPlaybook')))).toHaveLength(0);
  });

  it('a playbook run before and completed still lets "Coming up" offer it again (control)', () => {
    db.seed('life_event_plans', [{
      id: 'plan-baby-2024', family_id: h.app.familyId, template_key: 'new_baby', title: 'New Baby', status: 'completed', event_date: '2024-05-01', created_by: 'user-parent',
    }]);
    const tree = lifeEvents({ suggestions: [NEW_BABY] });
    expect(has(tree, t('lifeEvents.comingUp'))).toBe(true);
    expect(nodes(tree).filter((node) => node.type === 'button' && has(node, t('lifeEvents.startPlaybook')))).toHaveLength(1);
  });

  it('a fact added here is on the list, and pinning and removing it show too', async () => {
    await click(byName(lifeEvents(), 'Add', 'button'));
    change(field(lifeEvents(), t('lifeEvents.fridayTradition')), 'Sunday pancakes');
    change(field(lifeEvents(), t('lifeEvents.pizzaMovieNight')), 'Blueberry, always');
    await submit(form(lifeEvents()));
    expect(h.toasts.error).toEqual([]);
    expect(has(lifeEvents(), 'Blueberry, always')).toBe(true);

    await click(allByName(lifeEvents(), t('dialogTitle.pin'))[0]);
    expect(db.table('family_facts').filter((row) => row.is_pinned)).toHaveLength(1);
    expect(allByName(lifeEvents(), t('dialogTitle.unpin'))).toHaveLength(1);

    await click(byName(lifeEvents(), t('dialogTitle.unpin')));
    expect(db.table('family_facts').filter((row) => row.is_pinned)).toHaveLength(0);

    const before = allByName(lifeEvents(), t('lifeEvents.remove')).length;
    await click(allByName(lifeEvents(), t('lifeEvents.remove'))[0]);
    expect(db.table('family_facts')).toHaveLength(1);
    expect(allByName(lifeEvents(), t('lifeEvents.remove'))).toHaveLength(before - 1);
  });
});
