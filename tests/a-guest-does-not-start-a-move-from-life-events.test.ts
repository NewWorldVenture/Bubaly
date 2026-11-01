// household-roles N4-R1 — a guest could still start a move, and its task
// list, through the Life Events launcher.
//
// The N4 fix took Moving's write controls away from a guest (a guest views the
// household and does not plan in it, 0464). But Life & Milestones offers a
// "Moving Home" playbook to every role, and launchLifeEventAction checked only
// that someone was signed in: the launch (lib/life-events/launch.ts) writes a
// plan, its checklist, to-dos, reminders and, for a move, the move itself and
// its task list through lib/services/moving, in the guest's name. So a guest
// who had no Add in Moving opened a move from here.
//
// Driven here: the REAL action and launcher against an in-memory database, and
// the REAL module through tests/helpers/module-harness.tsx.
import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEventSuggestion } from '@/lib/life-events/detect';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, has, nodes, render } from './helpers/module-harness';
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
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
// The facts' own actions are not what this is about.
vi.mock('@/app/(app)/dashboard/knowledge/actions', () => ({
  forgetFactAction: vi.fn(), saveFactAction: vi.fn(), setFactPinnedAction: vi.fn(),
}));
// The server side of the launch: the session and the database.
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

const { launchLifeEventAction } = await import('@/app/(app)/dashboard/life-event-actions');
const { LifeEventsModule } = await import('@/components/modules/life-events-module');
const { LIFE_EVENT_TEMPLATES } = await import('@/lib/life-events/templates');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const GUEST_REFUSED = 'Guests can view this, but not change it.';
// What a launch writes, across the tables it reaches.
const WRITTEN = ['life_event_plans', 'life_event_plan_items', 'moves', 'move_tasks', 'todos', 'reminders'] as const;
let db: InMemorySupabase;

function as(role: string) {
  session.role = role;
  (h.app as unknown as { role: string }).role = role;
  h.app.userId = `user-${role}`;
}

/** A proposal from "Coming up", as the page computes it, for a move. */
const MOVE_SOON: LifeEventSuggestion = {
  templateKey: 'moving', title: 'Moving Home', reason: 'A move is coming up.', reasonKey: 'lifeEvents.comingUp',
  reasonParams: {}, eventDate: '2026-12-01', score: 80,
};
// Its props are optional, as the page may pass none; here they are passed.
const Module = LifeEventsModule as ComponentType<{ suggestions: LifeEventSuggestion[] }>;
const screen = () => render(h.hooks, createElement(Module, { suggestions: [MOVE_SOON] }));
/** The playbook cards: each is a button carrying its template's title. */
const playbookCards = (tree: ReturnType<typeof screen>) => nodes(tree)
  .filter((node) => node.type === 'button' && LIFE_EVENT_TEMPLATES.some((template) => has(node, template.title)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: { moves: { status: 'planning' } } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', ['parent', 'guest'].map((role) => ({
    id: `member-${role}`, family_id: h.app.familyId, user_id: `user-${role}`, role, display_name: role, is_active: true,
  })));
  as('parent');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('launchLifeEventAction', () => {
  it('refuses a guest the Moving Home playbook, and writes no move, task, plan, to-do or reminder', async () => {
    as('guest');
    expect(await launchLifeEventAction('moving', '2026-12-01')).toEqual({ ok: false, error: GUEST_REFUSED });
    for (const table of WRITTEN) expect(db.table(table), table).toEqual([]);
  });

  it('refuses a guest a checklist-only playbook too', async () => {
    as('guest');
    expect(await launchLifeEventAction('emergency_prep', '2026-12-01')).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(db.table('life_event_plans')).toEqual([]);
  });

  it('starts the move and its task list for a parent, as before (control)', async () => {
    const result = await launchLifeEventAction('moving', '2026-12-01');
    expect(result).toMatchObject({ ok: true, created: { handoff: { kind: 'move' } } });
    expect(db.table('moves')).toHaveLength(1);
    expect(db.table('moves')[0]).toMatchObject({ family_id: h.app.familyId, move_date: '2026-12-01', title: 'Moving Home' });
    expect(db.table('life_event_plans')).toHaveLength(1);
  });
});

describe('Life & Milestones offers Start only to whoever may start a playbook', () => {
  it('a guest sees what is coming up, and no Start and no playbook to launch', () => {
    as('guest');
    const tree = screen();
    expect(has(tree, t('lifeEvents.comingUp'))).toBe(true);
    expect(allByName(tree, t('lifeEvents.startPlaybook'))).toHaveLength(0);
    expect(has(tree, t('lifeEvents.startALifeEventPlaybook'))).toBe(false);
    expect(playbookCards(tree)).toHaveLength(0);
  });

  it('a parent is offered Start on the proposal and every playbook (control)', () => {
    const tree = screen();
    expect(allByName(tree, t('lifeEvents.startPlaybook'))).toHaveLength(1);
    expect(has(tree, t('lifeEvents.startALifeEventPlaybook'))).toBe(true);
    expect(playbookCards(tree)).toHaveLength(LIFE_EVENT_TEMPLATES.length);
  });
});
