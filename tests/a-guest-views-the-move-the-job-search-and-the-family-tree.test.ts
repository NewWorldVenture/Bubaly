// household-roles N4 and N11 — Moving, Career and the Family Tree rendered
// every control to every role and wrote their tables straight from the
// browser. A guest (an invited grandparent or neighbour) could delete the whole
// move with its tasks and boxes, a parent's job application and the career
// profile it hangs off, and a person on the family tree — a guest views the
// household and does not write to it (0464, as todos-module's `readOnly`).
//
// And in Moving, changing a move's date needs a parent or adult (the UI's
// canRecalculate and the move_recalculate_date RPC), while any member could
// call the whole move off, rewrite it or delete it with every task and box.
//
// The real modules, driven through tests/helpers/module-harness.tsx.
import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { allByName, has, nodes, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

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
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { MovingModule } = await import('@/components/modules/moving-module');
const { CareerModule } = await import('@/components/modules/career-module');
const { FamilyTreeModule } = await import('@/components/modules/family-tree-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

/** Sign in as `role`, the member `member-<role>` and the user `user-<role>`. */
function as(role: string) {
  const self = { id: `member-${role}`, display_name: role, role, is_active: true, color: null, birthday: null };
  h.app.selfMember = self;
  h.app.members = [self];
  h.app.userId = `user-${role}`;
  (h.app as unknown as { role: string }).role = role;
}
const screen = (Component: ComponentType) => render(h.hooks, createElement(Component));
const count = (tree: ReactNode, name: string | RegExp) => allByName(tree, name).length;
const titled = (tree: ReactNode, title: string) => nodes(tree).filter((n: Node) => n.type === 'button' && n.props.title === title).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Moving (N4, N11)', () => {
  // Five days out, so the header offers "Mark Packing →".
  const seedMove = (createdBy: string) => {
    db.seed('moves', [{ id: 'move-1', title: 'To Portland', move_date: '2026-10-25', status: 'planning', created_by: createdBy }]);
    db.seed('move_tasks', [{ id: 'task-1', move_id: 'move-1', title: 'Book the movers', due_date: '2026-10-22' }]);
  };
  const STATUS_SHORTCUT = /^Mark .+→$/;

  it('a guest sees the move and no control to change it', () => {
    seedMove('user-parent');
    as('guest');
    const tree = screen(MovingModule);
    expect(has(tree, 'To Portland')).toBe(true);
    for (const name of [t('moving.newMove'), t('moving.task'), 'Box', t('moving.editMove'), t('moving.deleteMove'),
      t('itemAction.edit', { name: 'Book the movers' }), t('itemAction.delete', { name: 'Book the movers' })]) {
      expect(count(tree, name), name).toBe(0);
    }
    expect(count(tree, STATUS_SHORTCUT)).toBe(0);
    expect(allByName(tree, 'Complete Book the movers')[0]?.props.disabled).toBe(true);
  });

  it('a teen works the checklist of a parent\'s move, but cannot call it off, rewrite it or delete it', () => {
    seedMove('user-parent');
    as('teen');
    const tree = screen(MovingModule);
    expect(count(tree, t('moving.task'))).toBe(1);
    expect(count(tree, t('itemAction.delete', { name: 'Book the movers' }))).toBe(1);
    expect(count(tree, t('moving.deleteMove'))).toBe(0);
    expect(count(tree, t('moving.editMove'))).toBe(0);
    expect(count(tree, STATUS_SHORTCUT)).toBe(0);
  });

  it('the teen who planned the move may manage it', () => {
    seedMove('user-teen');
    as('teen');
    const tree = screen(MovingModule);
    expect(count(tree, t('moving.deleteMove'))).toBe(1);
    expect(count(tree, t('moving.editMove'))).toBe(1);
    expect(count(tree, STATUS_SHORTCUT)).toBe(1);
  });

  it('a parent manages anyone\'s move', () => {
    seedMove('user-teen');
    as('parent');
    const tree = screen(MovingModule);
    expect(count(tree, t('moving.deleteMove'))).toBe(1);
    expect(count(tree, t('moving.editMove'))).toBe(1);
    expect(count(tree, STATUS_SHORTCUT)).toBe(1);
    expect(count(tree, t('moving.changeDate'))).toBe(1);
  });
});

describe('Career (N4)', () => {
  const seedSearch = () => {
    db.seed('career_profiles', [{ id: 'profile-1', member_id: 'member-parent', title: 'Product search' }]);
    db.seed('job_applications', [{ id: 'app-1', profile_id: 'profile-1', role_title: 'PM', company: 'Acme', stage: 'applied', updated_at: '2026-10-19T00:00:00Z' }]);
    db.seed('resume_versions', [{ id: 'resume-1', profile_id: 'profile-1', title: 'Main resume', updated_at: '2026-10-19T00:00:00Z' }]);
  };
  const controls = [t('career.application'), t('career.resume'), 'New search', 'Archive search', t('career.editProfile'),
    t('career.deleteProfile'), t('itemAction.edit', { name: 'Acme' }), t('itemAction.delete', { name: 'Acme' })];

  it('a guest sees the search and no control to change it', () => {
    seedSearch();
    as('guest');
    const tree = screen(CareerModule);
    expect(has(tree, 'Acme')).toBe(true);
    for (const name of controls) expect(count(tree, name), name).toBe(0);
  });

  it('a parent has every control', () => {
    seedSearch();
    as('parent');
    const tree = screen(CareerModule);
    for (const name of controls) expect(count(tree, name), name).toBe(1);
  });
});

describe('Family Tree (N4)', () => {
  const seedTree = () => db.seed('family_tree_nodes', [
    { id: 'node-1', family_id: h.app.familyId, name: 'Grandma Rose', relationship: 'grandparent', parent_node_id: null, birth_year: 1940, death_year: null, birth_place: null, bio: null, member_id: null, created_by: 'user-parent', created_at: '2026-01-01T00:00:00Z' },
  ]);

  it('a guest sees the tree and no control to change it', () => {
    seedTree();
    as('guest');
    const tree = screen(FamilyTreeModule);
    expect(has(tree, 'Grandma Rose')).toBe(true);
    expect(count(tree, t('familyTree.addPerson'))).toBe(0);
    expect(titled(tree, t('familyTree.edit'))).toBe(0);
    expect(titled(tree, t('familyTree.remove'))).toBe(0);
    expect(titled(tree, t('familyTree.view'))).toBe(1);
  });

  it('a parent may add, edit and remove', () => {
    seedTree();
    as('parent');
    const tree = screen(FamilyTreeModule);
    expect(count(tree, t('familyTree.addPerson'))).toBe(1);
    expect(titled(tree, t('familyTree.edit'))).toBe(1);
    expect(titled(tree, t('familyTree.remove'))).toBe(1);
  });
});
