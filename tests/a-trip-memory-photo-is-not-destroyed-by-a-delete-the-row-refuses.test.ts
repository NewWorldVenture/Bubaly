// N3 / N6 — a trip memory's delete removed the PHOTO first and the ROW second.
//
// The photo lives in the `documents` bucket under {familyId}/trip-memories/,
// with no documents row, so the bucket's delete policy (0007/0303) admits any
// member and the object went. The row delete then met 0481's
// trip_memories_delete, which is can_manage_family only, and matched nothing:
// "That change was not saved". A teen deleting a memory — even one she wrote —
// destroyed its photo for good and left the memory behind pointing at it, and
// no retry could bring it back. 0481 itself asked for the button to be shown
// only to a manager; that was never done.
//
// Driven through the REAL module (tests/helpers/module-harness.tsx) against an
// in-memory database whose trip_memories delete answers as 0481 does — zero
// rows for anyone but a parent or adult — and a bucket that, like the real
// one, lets any member remove the object.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

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
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { TripMemoriesModule } = await import('@/components/modules/trip-memories-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
const PHOTO = `${FAMILY}/trip-memories/11111111-1111-4111-8111-111111111111.jpg`;
let db: InMemorySupabase;

/** 0481's trip_memories_delete: a delete by anyone but a parent or adult matches no row. */
function asRole(role: string) {
  (h.app as unknown as { role: string }).role = role;
  h.app.selfMember = { ...(h.app.selfMember ?? {}), role };
  h.fault = null;
  const real = db.from.bind(db);
  (h.db as { from: unknown }).from = (table: string) => {
    const builder = real(table);
    if (table !== 'trip_memories' || role === 'parent' || role === 'adult') return builder;
    const del = builder.delete.bind(builder);
    builder.delete = () => del().eq('id', '__refused_by_rls__');
    return builder;
  };
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map([['documents', new Set([PHOTO])]]), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.stubGlobal('confirm', () => true);
  db.seed('trip_memories', [{
    id: 'memory-1', family_id: FAMILY, vacation_id: null, title: 'Sunset at the beach', memory_date: '2026-08-01',
    note: null, location: null, photo_path: PHOTO, member_id: null, created_by: 'user-1',
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const screen = () => render(h.hooks, createElement(TripMemoriesModule));
const photoKept = () => h.storage.objects.get('documents')?.has(PHOTO) ?? false;

describe('a trip memory\'s photo is not destroyed by a delete its row refuses', () => {
  it.each(['teen', 'child', 'caregiver', 'guest'])('a %s is offered no delete, and pressing every delete there is leaves the photo and the memory', async (role) => {
    asRole(role);
    const deletes = allByName(screen(), t('tripMemories.delete'));
    for (const button of deletes) await click(button);

    expect(deletes).toHaveLength(0);
    expect(photoKept()).toBe(true);
    expect(db.table('trip_memories')).toHaveLength(1);
  });

  it.each(['parent', 'adult'])('a %s deletes the memory and its photo', async (role) => {
    asRole(role);
    const [button] = allByName(screen(), t('tripMemories.delete'));
    await click(button);

    expect(db.table('trip_memories')).toHaveLength(0);
    expect(photoKept()).toBe(false);
    expect(h.toasts.success).toContain(t('tripMemoriesModule.deleted'));
  });
});
