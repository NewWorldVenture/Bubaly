import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIDEBAR_NAV_KEYS, ALL_SERVICES_KEYS } from '@/lib/constants/navigation';
import { outcomeNavigationPreset } from '@/lib/outcomes/navigation-preset';
import { MAX_SIDEBAR_NAV } from '@/lib/navigation/customize';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'me' }, active: { familyId: 'ours', member: { id: 'member' }, role: 'parent', family: { timezone: 'UTC' } } }) }));
const { loadSidebarNavigation, saveSidebarNavigation } = await import('@/lib/services/navigation');
const { saveSidebarNavAction } = await import('@/app/(app)/dashboard/navigation-actions');
let db: InMemorySupabase;
let scope: ServiceScope;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { user_preferences: [['user_id']] } });
  holder.db = db;
  scope = { db: db as never, userId: 'me', memberId: 'member', familyId: 'ours', role: 'parent', actorKind: 'member', tz: 'UTC' };
  db.seed('user_preferences', [
    { user_id: 'me', updated_at: '2026-09-09T00:00:00Z', notification_prefs: { sidebarNav: ['/home', '/dashboard/trips', '/dashboard/meals'], sidebarNavChildren: { '/dashboard/meals': [] }, security: { appLock: true }, email: false } },
    { user_id: 'other', updated_at: '2026-09-09T00:00:00Z', notification_prefs: { sidebarNav: ['/dashboard/calendar'], security: { appLock: false } } },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('personal outcome preset', () => {
  it('moves the existing destination first without changing the other pins or the global defaults', () => {
    const defaults = [...DEFAULT_SIDEBAR_NAV_KEYS];
    expect(ALL_SERVICES_KEYS).toContain('/dashboard/outcomes');
    expect(outcomeNavigationPreset(['/home', '/dashboard/outcomes', '/dashboard/meals'])).toEqual(['/dashboard/outcomes', '/home', '/dashboard/meals']);
    expect(outcomeNavigationPreset(['/home', '/dashboard/meals'])).toEqual(['/dashboard/outcomes', '/home', '/dashboard/meals']);
    expect(DEFAULT_SIDEBAR_NAV_KEYS).toEqual(defaults);
    expect(outcomeNavigationPreset(Array.from({ length: MAX_SIDEBAR_NAV }, (_, i) => `/page-${i}`))).toBeNull();
  });

  it('persists only the caller’s layout, preserving paid pins, child choices and unrelated preferences', async () => {
    const beforeOther = structuredClone(db.table('user_preferences')[1]);
    const result = await saveSidebarNavAction({ preset: 'outcomes' });
    expect(result).toMatchObject({ ok: true, nav: ['/dashboard/outcomes', '/home', '/dashboard/trips', '/dashboard/meals'], children: { '/dashboard/meals': [] } });
    expect(db.table('user_preferences')[0].notification_prefs).toEqual({ sidebarNav: result.nav, sidebarNavChildren: { '/dashboard/meals': [] }, security: { appLock: true }, email: false });
    expect(db.table('user_preferences')[1]).toEqual(beforeOther);
    expect(await loadSidebarNavigation(scope)).toMatchObject({ ok: true, data: { nav: result.nav } });
    expect(await saveSidebarNavAction({ preset: 'outcomes' })).toMatchObject({ ok: true, nav: result.nav });
  });

  it('uses defaults only when the caller has no saved layout', async () => {
    db.replace('user_preferences', []);
    expect(await saveSidebarNavigation(scope, { preset: 'outcomes' })).toMatchObject({ ok: true, data: { nav: ['/dashboard/outcomes', ...DEFAULT_SIDEBAR_NAV_KEYS.filter((href) => href !== '/dashboard/outcomes')] } });
    expect(db.table('user_preferences')).toHaveLength(1);
    expect(db.table('user_preferences')[0].user_id).toBe('me');
  });

  it('continues to save an explicit manual layout while preserving preferences outside that edit', async () => {
    expect(await saveSidebarNavAction({ keys: ['/home', '/dashboard/calendar'], children: { '/dashboard/calendar': [] } })).toMatchObject({ ok: true });
    expect(db.table('user_preferences')[0].notification_prefs).toEqual({ sidebarNav: ['/home', '/dashboard/calendar'], sidebarNavChildren: { '/dashboard/calendar': [] }, security: { appLock: true }, email: false });
  });

  it('does not overwrite a row when the preference read fails', async () => {
    const before = structuredClone(db.table('user_preferences'));
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('Read failed'); });
    expect(await saveSidebarNavigation(scope, { preset: 'outcomes' })).toMatchObject({ ok: false, retryable: true });
    expect(await loadSidebarNavigation(scope)).toMatchObject({ ok: false, retryable: true });
    expect(db.table('user_preferences')).toEqual(before);
    expect(console.error).toHaveBeenCalled();
  });

  it('refuses a stale merge when another device changed preferences after the read', async () => {
    const from = db.from.bind(db);
    let calls = 0;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (++calls === 2) { db.table('user_preferences')[0].updated_at = '2026-09-09T00:00:01Z'; db.table('user_preferences')[0].notification_prefs = { concurrent: 'keep' }; }
      return from(table);
    });
    expect(await saveSidebarNavigation(scope, { preset: 'outcomes' })).toMatchObject({ ok: false, retryable: true });
    expect(db.table('user_preferences')[0].notification_prefs).toEqual({ concurrent: 'keep' });
  });

  it.each([{ userId: null }, { actorKind: 'ai' as const }, { actorKind: 'system' as const }])('refuses an unowned or automated preset write: %j', async (patch) => {
    expect(await saveSidebarNavigation({ ...scope, ...patch }, { preset: 'outcomes' })).toMatchObject({ ok: false });
    expect(db.log).toHaveLength(0);
  });
});
