import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { has, nodes, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Removing a member is a soft `is_active = false` (REMOVED_MEMBER_PATCH,
// lib/constants/roles.ts), so a removed child's screen_time_entries,
// screen_time_limits and behavior_logs stay in the family. The roster the
// pages name people from is the ACTIVE one (components/app/app-context.tsx),
// but both pages built their per-child insight cards from whatever member ids
// the rows carried. So a removed child kept a card for good, headed "Member":
// Screen Time showed their minutes today, their week, their limit and a
// "Set daily limit" control; Behavior showed their balance score, counts,
// streak and six-week trend. The pets page drops a removed pet's records the
// same way (F10).
//
// Driven through the REAL modules (tests/helpers/module-harness.tsx).

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { ScreenTimeModule } = await import('@/components/modules/screen-time-module');
const { BehaviorModule } = await import('@/components/modules/behavior-module');

const FAMILY = h.app.familyId;
const KIT = 'kid';
const GONE = 'removed-kid';
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  // The active roster, as the app context reads it: the removed child is not on it.
  h.app.members = [
    { id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: KIT, display_name: 'Kit', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'UTC' };
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** The per-member insight cards, keyed by member id. */
const cards = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'div' && typeof n.key === 'string' && [KIT, GONE, 'member-1'].includes(n.key));
const cardOf = (tree: ReactNode, id: string) => cards(tree).find((n) => n.key === id) as Node | undefined;

describe('Screen Time', () => {
  beforeEach(() => {
    db.seed('screen_time_limits', [
      { id: 'l1', family_id: FAMILY, member_id: KIT, daily_minutes: 120 },
      { id: 'l2', family_id: FAMILY, member_id: GONE, daily_minutes: 60 },
    ]);
    db.seed('screen_time_entries', [
      { id: 'e1', family_id: FAMILY, member_id: KIT, entry_date: '2026-10-12', minutes: 30, category: 'educational', device: null, note: null },
      { id: 'e2', family_id: FAMILY, member_id: GONE, entry_date: '2026-10-12', minutes: 200, category: 'gaming', device: null, note: null },
    ]);
  });

  it('a removed child has no card, and no "Member" card stands in for them', () => {
    const tree = render(h.hooks, createElement(ScreenTimeModule));
    expect(cardOf(tree, GONE)).toBeUndefined();
    expect(cards(tree).map((card) => card.key).sort()).toEqual([KIT, 'member-1'].sort());
    expect(cards(tree).some((card) => has(card, 'Member'))).toBe(false);
  });

  it('the children still in the family keep theirs', () => {
    const tree = render(h.hooks, createElement(ScreenTimeModule));
    const kit = cardOf(tree, KIT) as Node;
    expect(has(kit, 'Kit')).toBe(true);
    expect(has(kit, 'today / 2h')).toBe(true);
    expect(has(kit, '30m')).toBe(true);
  });
});

describe('Behavior', () => {
  beforeEach(() => {
    db.seed('behavior_logs', [
      { id: 'b1', family_id: FAMILY, member_id: KIT, kind: 'positive', category: 'kindness', note: 'Shared his lunch', points: 1, occurred_at: '2026-10-12T09:00:00Z', logged_by: 'user-1' },
      { id: 'b2', family_id: FAMILY, member_id: GONE, kind: 'concern', category: 'respect', note: 'Slammed the door', points: 0, occurred_at: '2026-10-11T09:00:00Z', logged_by: 'user-1' },
    ]);
  });

  it('a removed child has no insight card, and no "Member" card stands in for them', () => {
    const tree = render(h.hooks, createElement(BehaviorModule));
    expect(cardOf(tree, GONE)).toBeUndefined();
    expect(cards(tree).map((card) => card.key)).toEqual([KIT]);
    expect(cards(tree).some((card) => has(card, 'Member'))).toBe(false);
  });

  it('the children still in the family keep theirs', () => {
    const tree = render(h.hooks, createElement(BehaviorModule));
    const kit = cardOf(tree, KIT) as Node;
    expect(has(kit, 'Kit')).toBe(true);
    expect(has(kit, '1 positive')).toBe(true);
    expect(has(kit, '0 concern')).toBe(true);
  });
});
