import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// A celebration a parent adds or removes on the Celebrations page shows (or
// goes) at once, without a reload.
//
// `family_dates` is not in the realtime publication
// (lib/realtime/published-tables.ts), so `useRealtimeQuery` opens no channel
// for it and the list changes only when the module reads it again. Neither
// write did: a parent added "Mom & Dad's anniversary", was told "Celebration
// added", and the list did not show it; a removed date was "Removed" and
// stayed on screen, and removing it again said "That change wasn't saved".
//
// Driven with the module harness: the real component and lib helpers against
// an in-memory database, with a list that changes only when the component asks
// it to, which is what the real hook does for an unpublished table.

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
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { CelebrationsModule } = await import('@/components/modules/celebrations-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'UTC';
  h.app.members = [{ id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null }];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { await settle(); vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = () => render(h.hooks, createElement(CelebrationsModule));
const fieldBy = (tree: ReactNode, test: (n: Node) => boolean) => {
  const found = nodes(form(tree)).find((n) => typeof n.type === 'string' && test(n));
  if (!found) throw new Error('no such field');
  return found;
};
async function addCelebration(title: string, date: string) {
  await click(byName(screen(), 'Add'));
  change(fieldBy(screen(), (n) => n.type === 'input' && n.props.placeholder === t('celebrationsModule.eGMomDadS')), title);
  change(fieldBy(screen(), (n) => n.type === 'input' && n.props.type === 'date'), date);
  await submit(form(screen()));
}
const gran = { id: 'd1', family_id: FAMILY, title: 'Gran\'s birthday', kind: 'birthday', event_date: '1950-11-20', member_id: null, notes: null, remind_days: 7, created_by: 'user-1' };

describe('a celebration added or removed shows at once', () => {
  it('a celebration a parent adds is on the list straight away', async () => {
    expect(has(screen(), t('celebrations.noUpcomingCelebrations'))).toBe(true);

    await addCelebration('Mom & Dad\'s anniversary', '2010-11-14');

    expect(db.table('family_dates')).toEqual([expect.objectContaining({ title: 'Mom & Dad\'s anniversary', event_date: '2010-11-14' })]);
    expect(h.toasts.success).toEqual([t('celebrationsModule.celebrationAdded')]);
    expect(has(screen(), 'Mom & Dad\'s anniversary')).toBe(true);
    expect(has(screen(), t('celebrations.noUpcomingCelebrations'))).toBe(false);
  });

  it('a celebration a parent removes leaves the list straight away', async () => {
    db.seed('family_dates', [gran]);
    expect(has(screen(), 'Gran\'s birthday')).toBe(true);

    await click(byName(screen(), t('a11y.delete')));

    expect(db.table('family_dates')).toEqual([]);
    expect(h.toasts.success).toEqual([t('celebrationsModule.removed')]);
    expect(h.toasts.error).toEqual([]);
    expect(has(screen(), 'Gran\'s birthday')).toBe(false);
  });

  it('a refused add says so and shows nothing new', async () => {
    h.fault = (table, calls) => (table === 'family_dates' && calls.includes('insert')
      ? { code: '42501', message: 'new row violates row-level security policy for table "family_dates"' } : null);

    await addCelebration('Mom & Dad\'s anniversary', '2010-11-14');

    expect(db.table('family_dates')).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
    expect(has(screen(), 'Mom & Dad\'s anniversary')).toBe(false);
  });

  it('a refused removal says so and keeps the date on the list', async () => {
    db.seed('family_dates', [gran]);
    h.fault = (table, calls) => (table === 'family_dates' && calls.includes('delete')
      ? { code: '42501', message: 'permission denied for table family_dates' } : null);

    await click(byName(screen(), t('a11y.delete')));

    expect(db.table('family_dates')).toHaveLength(1);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
    expect(has(screen(), 'Gran\'s birthday')).toBe(true);
  });
});
