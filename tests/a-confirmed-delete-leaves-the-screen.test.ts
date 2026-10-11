import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS, MEMBER } from './helpers/household-fixtures';
import { allByName, byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H3 — the household modules said a delete worked and left the row on screen.
//
// Every table below is in the realtime publication (0240–0248) WITHOUT
// REPLICA IDENTITY FULL, so a DELETE's old tuple carries only the primary key
// and the `family_id=eq.<family>` filter every subscription uses can never
// match it: the channel hears nothing. The handlers confirmed the delete with
// `.select('id')`, toasted "removed", and relied on that event — so the row
// stayed until a reload, and deleting it again matched nothing and said "That
// change was not saved". In the moving module the effect that picks the live
// move then re-selected the move just deleted, with its cascaded tasks.
//
// These drive each REAL module through tests/helpers/module-harness.tsx. Its
// realtime hook changes the screen only when the component asks (refresh or
// setData), which is the real hook's behaviour for these deletes; the database
// is an InMemorySupabase applying the filters each delete names.

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
vi.mock('@/components/media/family-media-img', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { SleepModule } = await import('@/components/modules/sleep-module');
const { InventoryModule } = await import('@/components/modules/inventory-module');
const { MovingModule } = await import('@/components/modules/moving-module');
const { ClosetModule } = await import('@/components/modules/closet-module');
const { DeclutterModule } = await import('@/components/modules/declutter-module');
const { CareerModule } = await import('@/components/modules/career-module');
const { LanguageModule } = await import('@/components/modules/language-module');
const { ProjectsModule } = await import('@/components/modules/projects-module');
const { WatchlistModule } = await import('@/components/modules/watchlist-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = (Component: ComponentType) => render(h.hooks, createElement(Component));
const labelled = (tree: ReactNode, label: string) => allByName(tree, label).length;

/** Click the delete, then show the screen as the family now sees it. */
async function remove(Component: ComponentType, label: string): Promise<ReactNode> {
  await click(byName(screen(Component), label));
  return screen(Component);
}

describe('a confirmed delete leaves the screen without waiting for an event that never comes', () => {
  it('sleep: a removed night leaves the chart', async () => {
    db.seed('sleep_logs', [{ id: 'night-1', sleep_date: '2026-10-09', bedtime: '2026-10-08T21:00:00+00:00', wake_time: '2026-10-09T06:00:00+00:00', duration_min: 540 }]);
    const label = t('sleep.deleteNight', { date: '2026-10-09' });
    expect(labelled(screen(SleepModule), label)).toBe(1);

    const after = await remove(SleepModule, label);

    expect(db.table('sleep_logs')).toEqual([]);
    expect(h.toasts.success).toContain(t('sleepModule.nightRemoved'));
    expect(labelled(after, label)).toBe(0);
  });

  it('inventory: a removed item leaves the list', async () => {
    db.seed('inventory_items', [{ id: 'item-1', name: 'Ski helmet' }]);
    const label = t('itemAction.remove', { name: 'Ski helmet' });
    expect(labelled(screen(InventoryModule), label)).toBe(1);

    const after = await remove(InventoryModule, label);

    expect(db.table('inventory_items')).toEqual([]);
    expect(h.toasts.success).toContain(t('inventoryModule.itemRemoved'));
    expect(labelled(after, label)).toBe(0);
  });

  it('inventory: a removed item\'s cascaded moves leave the Recent moves panel instead of turning into "Item: …"', async () => {
    db.seed('home_locations', [{ id: 'loc-1', name: 'Garage shelf', kind: 'shelf' }, { id: 'loc-2', name: 'Hall closet', kind: 'closet' }]);
    db.seed('inventory_items', [{ id: 'item-1', name: 'Ski helmet', location_id: 'loc-2' }, { id: 'item-2', name: 'Tent', location_id: 'loc-1' }]);
    db.seed('inventory_moves', [
      { id: 'move-1', item_id: 'item-1', from_location_id: 'loc-1', to_location_id: 'loc-2', moved_at: '2026-10-09T12:00:00+00:00', reason: 'tidy' },
      { id: 'move-2', item_id: 'item-2', from_location_id: 'loc-2', to_location_id: 'loc-1', moved_at: '2026-10-08T12:00:00+00:00', reason: 'camping' },
    ]);
    const before = screen(InventoryModule);
    expect(has(before, t('inventory.recentMoves'))).toBe(true);
    expect(has(before, 'Ski helmet: Garage shelf → Hall closet')).toBe(true);
    expect(has(before, 'Tent: Hall closet → Garage shelf')).toBe(true);

    await click(byName(before, t('itemAction.remove', { name: 'Ski helmet' })));
    // What ON DELETE CASCADE (0242: inventory_moves.item_id) does in the
    // database. inventory_moves is DELETE-blind like the item itself, so no
    // event tells the panel either.
    db.replace('inventory_moves', db.table('inventory_moves').filter((row) => row.item_id !== 'item-1'));
    const after = screen(InventoryModule);

    expect(db.table('inventory_items').map((row) => row.id)).toEqual(['item-2']);
    expect(h.toasts.success).toContain(t('inventoryModule.itemRemoved'));
    // The deleted item's move is gone, not relabelled with the fallback name.
    expect(has(after, 'Garage shelf → Hall closet')).toBe(false);
    expect(has(after, 'Item: ')).toBe(false);
    // Only that item's moves went: the rest of the panel is untouched.
    expect(has(after, t('inventory.recentMoves'))).toBe(true);
    expect(has(after, 'Tent: Hall closet → Garage shelf')).toBe(true);
  });

  it('inventory: a deleted location leaves the room list and the item form\'s location picker', async () => {
    db.seed('home_locations', [{ id: 'loc-1', name: 'Garage shelf', kind: 'shelf' }, { id: 'loc-2', name: 'Hall closet', kind: 'closet' }]);
    const label = t('itemAction.delete', { name: 'Garage shelf' });
    expect(labelled(screen(InventoryModule), label)).toBe(1);

    const after = await remove(InventoryModule, label);

    expect(db.table('home_locations').map((row) => row.id)).toEqual(['loc-2']);
    expect(labelled(after, label)).toBe(0);
    // The picker the next save is offered: a deleted id here is a foreign-key
    // refusal waiting to happen.
    await click(byName(after, t('inventory.addItem').trim()));
    const picker = screen(InventoryModule);
    const offered = allOptions(picker);
    expect(offered).toContain('loc-2');
    expect(offered).not.toContain('loc-1');
  });

  it('moving: a deleted task and a deleted box leave the timeline and the box list', async () => {
    db.seed('moves', [{ id: 'move-1', title: 'To Portland', move_date: '2026-11-20' }]);
    db.seed('move_tasks', [{ id: 'task-1', move_id: 'move-1', title: 'Book the movers', due_date: '2026-11-01' }]);
    db.seed('move_boxes', [{ id: 'box-1', move_id: 'move-1', box_number: 7, label: 'Kitchen' }]);
    const taskLabel = t('itemAction.delete', { name: 'Book the movers' });
    expect(labelled(screen(MovingModule), taskLabel)).toBe(1);

    const afterTask = await remove(MovingModule, taskLabel);
    expect(db.table('move_tasks')).toEqual([]);
    expect(labelled(afterTask, taskLabel)).toBe(0);

    await click(byName(afterTask, /^📦|Boxes/));
    const boxLabel = t('moving.deleteBoxN', { number: 7 });
    expect(labelled(screen(MovingModule), boxLabel)).toBe(1);
    const afterBox = await remove(MovingModule, boxLabel);
    expect(db.table('move_boxes')).toEqual([]);
    expect(labelled(afterBox, boxLabel)).toBe(0);
  });

  it('moving: a deleted move is not re-selected with its cascaded tasks', async () => {
    db.seed('moves', [
      { id: 'move-1', title: 'To Portland', move_date: '2026-11-20', status: 'planning' },
      { id: 'move-0', title: 'Old flat', move_date: '2025-01-10', status: 'done' },
    ]);
    db.seed('move_tasks', [{ id: 'task-1', move_id: 'move-1', title: 'Book the movers', due_date: '2026-11-01' }]);
    expect(has(screen(MovingModule), 'Book the movers')).toBe(true);

    await click(byName(screen(MovingModule), t('moving.deleteMove')));
    // What ON DELETE CASCADE (0245) does in the database.
    db.replace('move_tasks', db.table('move_tasks').filter((row) => row.move_id !== 'move-1'));
    const after = screen(MovingModule);

    expect(db.table('moves').map((row) => row.id)).toEqual(['move-0']);
    expect(h.toasts.success).toContain(t('movingModule.moveDeleted'));
    expect(has(after, 'To Portland')).toBe(false);
    expect(has(after, 'Book the movers')).toBe(false);
  });

  it('closet: a removed item and a deleted outfit leave the screen', async () => {
    db.seed('wardrobe_items', [{ id: 'shirt', name: 'Grey hoodie' }]);
    db.seed('outfits', [{ id: 'outfit-1', name: 'Rainy school day', item_ids: ['shirt'] }]);
    const itemLabel = t('itemAction.remove', { name: 'Grey hoodie' });
    expect(labelled(screen(ClosetModule), itemLabel)).toBe(1);

    const afterItem = await remove(ClosetModule, itemLabel);
    expect(db.table('wardrobe_items')).toEqual([]);
    expect(labelled(afterItem, itemLabel)).toBe(0);

    const outfitLabel = t('closet.deleteOutfit');
    expect(labelled(afterItem, outfitLabel)).toBe(1);
    const afterOutfit = await remove(ClosetModule, outfitLabel);
    expect(db.table('outfits')).toEqual([]);
    expect(labelled(afterOutfit, outfitLabel)).toBe(0);
    expect(has(afterOutfit, 'Rainy school day')).toBe(false);
  });

  it('declutter: a deleted mission leaves the list', async () => {
    db.seed('declutter_missions', [{ id: 'mission-1', title: 'Clear the counter', scheduled_for: '2026-10-10' }]);
    const label = t('itemAction.delete', { name: 'Clear the counter' });
    expect(labelled(screen(DeclutterModule), label)).toBe(1);

    const after = await remove(DeclutterModule, label);

    expect(db.table('declutter_missions')).toEqual([]);
    expect(h.toasts.success).toContain(t('declutterModule.missionDeleted'));
    expect(labelled(after, label)).toBe(0);
  });

  it('career: a removed application, a deleted resume and a deleted search leave the screen', async () => {
    db.seed('career_profiles', [{ id: 'profile-1', title: 'Backend roles' }]);
    db.seed('job_applications', [{ id: 'app-1', profile_id: 'profile-1', company: 'Acme', role_title: 'Engineer' }]);
    db.seed('resume_versions', [{ id: 'resume-1', profile_id: 'profile-1', title: 'Resume v1' }]);
    const appLabel = t('itemAction.delete', { name: 'Acme' });
    expect(labelled(screen(CareerModule), appLabel)).toBe(1);
    const afterApp = await remove(CareerModule, appLabel);
    expect(db.table('job_applications')).toEqual([]);
    expect(labelled(afterApp, appLabel)).toBe(0);

    await click(byName(afterApp, /Resumes/));
    const resumeLabel = t('itemAction.delete', { name: 'Resume v1' });
    expect(labelled(screen(CareerModule), resumeLabel)).toBe(1);
    const afterResume = await remove(CareerModule, resumeLabel);
    expect(db.table('resume_versions')).toEqual([]);
    expect(labelled(afterResume, resumeLabel)).toBe(0);

    const afterProfile = await remove(CareerModule, t('career.deleteProfile'));
    expect(db.table('career_profiles')).toEqual([]);
    expect(has(afterProfile, 'Backend roles')).toBe(false);
  });

  it('language: a deleted card, a deleted session and a deleted goal leave the screen', async () => {
    db.seed('language_goals', [{ id: 'goal-1' }]);
    db.seed('vocab_cards', [{ id: 'card-1', goal_id: 'goal-1', term: 'hola', translation: 'hello', due_on: '2026-10-10' }]);
    db.seed('language_sessions', [{ id: 'session-1', goal_id: 'goal-1', practiced_on: '2026-10-09', topic: 'Ordering food' }]);

    await click(byName(screen(LanguageModule), /^Practice log/));
    const sessionLabel = t('language.deleteSession');
    expect(labelled(screen(LanguageModule), sessionLabel)).toBe(1);
    const afterSession = await remove(LanguageModule, sessionLabel);
    expect(db.table('language_sessions')).toEqual([]);
    expect(labelled(afterSession, sessionLabel)).toBe(0);

    await click(byName(afterSession, /^Cards/));
    const cardLabel = t('itemAction.delete', { name: 'hola' });
    expect(labelled(screen(LanguageModule), cardLabel)).toBe(1);
    const afterCard = await remove(LanguageModule, cardLabel);
    expect(db.table('vocab_cards')).toEqual([]);
    expect(labelled(afterCard, cardLabel)).toBe(0);

    const afterGoal = await remove(LanguageModule, t('language.deleteGoal'));
    expect(db.table('language_goals')).toEqual([]);
    expect(labelled(afterGoal, t('language.deleteGoal'))).toBe(0);
  });

  it('projects: a deleted material and a deleted quote leave the open project', async () => {
    db.seed('home_projects', [{ id: 'project-1', title: 'Fix the fence' }]);
    db.seed('project_materials', [{ id: 'mat-1', project_id: 'project-1', name: 'Fence posts' }]);
    db.seed('project_quotes', [{ id: 'quote-1', project_id: 'project-1', contractor_name: 'Bob Builders', amount_cents: 50000 }]);
    await click(byName(screen(ProjectsModule), /Fix the fence/));

    const materialLabel = t('itemAction.delete', { name: 'Fence posts' });
    expect(labelled(screen(ProjectsModule), materialLabel)).toBe(1);
    const afterMaterial = await remove(ProjectsModule, materialLabel);
    expect(db.table('project_materials')).toEqual([]);
    expect(labelled(afterMaterial, materialLabel)).toBe(0);

    await click(byName(afterMaterial, /^Quotes/));
    const quoteLabel = t('projects.deleteQuote');
    expect(labelled(screen(ProjectsModule), quoteLabel)).toBe(1);
    const afterQuote = await remove(ProjectsModule, quoteLabel);
    expect(db.table('project_quotes')).toEqual([]);
    expect(labelled(afterQuote, quoteLabel)).toBe(0);
  });

  it('watchlist: a deleted watch session leaves the history', async () => {
    db.seed('watch_sessions', [{ id: 'watch-1', title_name: 'Paddington', watched_on: '2026-10-09' }]);
    const label = t('watchlist.deleteSession');
    expect(labelled(screen(WatchlistModule), label)).toBe(1);

    const after = await remove(WatchlistModule, label);

    expect(db.table('watch_sessions')).toEqual([]);
    expect(labelled(after, label)).toBe(0);
    expect(has(after, 'Paddington')).toBe(false);
  });
});

/** Every option value offered by the open form's selects. */
function allOptions(tree: ReactNode): string[] {
  const out: string[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const props = (node as { type: unknown; props: Record<string, unknown> }).props;
    if ((node as { type: unknown }).type === 'option' && typeof props.value === 'string' && props.value) out.push(props.value);
    walk(props.children as ReactNode);
  };
  walk(tree);
  return out;
}

void MEMBER;
