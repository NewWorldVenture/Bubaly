import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY } from './helpers/household-fixtures';
import { byName, click, form, nodes, render, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// SEC-002 / H2 for reminders. A reminder's photo is uploaded to the PUBLIC
// family-media bucket the moment it is picked, and the row keeps its public
// URL. Nothing ever removed one: a photo replaced or cleared before saving,
// the upload of a form closed unsaved or refused, the photo an edit replaced,
// a deleted reminder's photo — each stayed readable at its URL for good, with
// nothing in the product left pointing at it. A deleted reminder's URL had
// been in every member's reads, a member removed since included. Closet,
// inventory and photos already remove theirs; reminders never imported it.
//
// A recurring reminder's next occurrence is spawned with the SAME image_url,
// so a photo another reminder still shows is kept.
//
// The form is the real module (tests/helpers/module-harness.tsx) against an
// in-memory database and a bucket that answers a refused delete with
// `error: null` and an empty list; the delete is the real service.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('server-only', () => ({}));
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
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/media/family-media-img', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({
  createReminderAction: vi.fn(), deleteReminderAction: vi.fn(), snoozeReminderAction: vi.fn(),
}));

const { RemindersModule } = await import('@/components/modules/reminders-module');
const { deleteReminder } = await import('@/lib/services/reminders');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const PUBLIC = 'https://project.supabase.invalid/storage/v1/object/public/family-media/';
const SAVED = `${FAMILY}/reminders/11111111-1111-4111-8111-111111111111.jpg`;

let db: InMemorySupabase;

function reminderRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, family_id: FAMILY, created_by: 'user-1', title: 'Pick up prescription', notes: null, kind: 'time',
    priority: 'medium', recurrence: 'none', status: 'active', remind_at: null, location_name: null,
    member_id: null, assigned_to_id: null, url: null, flagged: false, early_reminder_minutes: null,
    image_url: null, subtasks: [], list_id: null, tags: [], idempotency_key: null, snoozed_until: null,
    completed_at: null, ai_suggested: false, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: { agent_activity: { id: 'activity' } } });
  h.db = db;
  h.app = { ...h.app, role: 'parent' } as typeof h.app;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const bucket = () => [...(h.storage.objects.get('family-media') ?? [])].sort();
const store = (...paths: string[]) => { h.storage.objects.set('family-media', new Set(paths)); };
const screen = () => render(h.hooks, createElement(RemindersModule));
const imageOf = (id: string) => db.table('family_reminders').find((row) => row.id === id)?.image_url;

/** Choose a file in the open form's image input, as the browser would. */
async function choosePhoto(tree: ReactNode, name: string) {
  const input = nodes(form(tree)).find((node) => node.type === 'input' && node.props.type === 'file') as Node;
  (input.props.onChange as (event: unknown) => void)({ target: { files: [{ name, size: 2048 }] } });
  await settle();
}
const openNew = async () => click(byName(screen(), t('reminders.newReminder')));
const openEdit = async () => click(byName(screen(), t('reminders.editReminder')));
const cancel = async () => click(byName(form(screen()), t('reminders.cancel')));
const save = async () => submit(form(screen()), { title: 'Pick up prescription' });

describe('the reminder form: a photo the saved row does not point at leaves the bucket', () => {
  it('a new reminder\'s photo, closed unsaved, does not stay behind', async () => {
    await openNew();
    await choosePhoto(screen(), 'draft.jpg');
    expect(bucket()).toHaveLength(1);
    expect(bucket()[0]).toMatch(new RegExp(`^${FAMILY}/reminders/.+\\.jpg$`));

    await cancel();

    expect(bucket()).toEqual([]);
    expect(db.table('family_reminders')).toEqual([]);
  });

  it('a photo replaced before saving goes, the saved one stays', async () => {
    await openNew();
    await choosePhoto(screen(), 'first.jpg');
    const first = bucket()[0];
    await choosePhoto(screen(), 'second.jpg');
    const second = bucket().find((path) => path !== first)!;

    await save();

    expect(db.table('family_reminders')).toHaveLength(1);
    expect(db.table('family_reminders')[0].image_url).toBe(`${PUBLIC}${second}`);
    expect(bucket()).toEqual([second]);
  });

  it('a refused save keeps the photo while the form is open, and closing then removes it', async () => {
    await openNew();
    await choosePhoto(screen(), 'draft.jpg');
    h.fault = (table, calls) => (table === 'family_reminders' && calls.includes('insert') ? { code: '42501', message: 'new row violates row-level security policy' } : null);

    await save();
    // The write was sent and refused, not stopped by the form's own checks.
    expect(h.calls.some((call) => call.table === 'family_reminders' && call.calls.includes('insert'))).toBe(true);
    expect(db.table('family_reminders')).toEqual([]);
    expect(bucket()).toHaveLength(1);

    await cancel();
    expect(bucket()).toEqual([]);
  });

  it('an edit that replaces the photo removes the old one when no other reminder shows it', async () => {
    db.seed('family_reminders', [reminderRow('r1', { image_url: `${PUBLIC}${SAVED}` })]);
    store(SAVED);
    await openEdit();
    await choosePhoto(screen(), 'new.jpg');
    const uploaded = bucket().find((path) => path !== SAVED)!;

    await save();

    expect(imageOf('r1')).toBe(`${PUBLIC}${uploaded}`);
    expect(bucket()).toEqual([uploaded]);
  });

  it('an edit keeps the old photo a recurring reminder\'s other occurrence still shows', async () => {
    db.seed('family_reminders', [
      reminderRow('r1', { image_url: `${PUBLIC}${SAVED}`, recurrence: 'weekly' }),
      reminderRow('r1-done', { image_url: `${PUBLIC}${SAVED}`, recurrence: 'weekly', status: 'completed' }),
    ]);
    store(SAVED);
    await openEdit();
    await click(byName(form(screen()), t('reminders.removeImage')));

    await save();

    expect(imageOf('r1')).toBeNull();
    expect(imageOf('r1-done')).toBe(`${PUBLIC}${SAVED}`);
    expect(bucket()).toEqual([SAVED]);
  });

  it('closing an edit unsaved leaves the saved photo alone', async () => {
    db.seed('family_reminders', [reminderRow('r1', { image_url: `${PUBLIC}${SAVED}` })]);
    store(SAVED);
    await openEdit();
    await choosePhoto(screen(), 'other.jpg');
    expect(bucket()).toHaveLength(2);

    await cancel();

    expect(bucket()).toEqual([SAVED]);
    expect(imageOf('r1')).toBe(`${PUBLIC}${SAVED}`);
  });
});

describe('deleting a reminder removes its photo unless another reminder shows it', () => {
  const scope = (): ServiceScope => ({
    db: { from: (table: string) => db.from(table), storage: { from: (name: string) => bucketClient(name) } } as unknown as SupabaseClient<Database>,
    familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-10-21T12:00:00Z'),
  });
  // The service's own client: the same bucket the module harness models.
  function bucketClient(name: string) {
    const objects = h.storage.objects.get(name) ?? new Set<string>();
    h.storage.objects.set(name, objects);
    return {
      remove: async (paths: string[]) => {
        const gone = paths.filter((path) => !h.storage.refused.has(path) && objects.delete(path));
        return { data: gone.map((path) => ({ name: path })), error: null };
      },
      list: async (folder: string, options?: { search?: string }) => ({
        data: [...objects].filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1))
          .filter((n) => !options?.search || n.startsWith(options.search)).map((n) => ({ name: n })),
        error: null,
      }),
    };
  }

  it('the photo goes with the reminder', async () => {
    db.seed('family_reminders', [reminderRow('r1', { image_url: `${PUBLIC}${SAVED}` })]);
    store(SAVED);

    const result = await deleteReminder(scope(), 'r1');

    expect(result.ok).toBe(true);
    expect(db.table('family_reminders')).toEqual([]);
    expect(bucket()).toEqual([]);
  });

  it('a photo the next occurrence still shows is kept', async () => {
    db.seed('family_reminders', [
      reminderRow('r1', { image_url: `${PUBLIC}${SAVED}`, recurrence: 'weekly', status: 'completed' }),
      reminderRow('r2', { image_url: `${PUBLIC}${SAVED}`, recurrence: 'weekly' }),
    ]);
    store(SAVED);

    expect((await deleteReminder(scope(), 'r1')).ok).toBe(true);

    expect(bucket()).toEqual([SAVED]);
    expect(imageOf('r2')).toBe(`${PUBLIC}${SAVED}`);
  });

  it('never removes an object outside the family\'s reminders folder', async () => {
    const elsewhere = `${FAMILY}/photos/22222222-2222-4222-8222-222222222222.jpg`;
    db.seed('family_reminders', [reminderRow('r1', { image_url: `${PUBLIC}${elsewhere}` })]);
    store(elsewhere);

    expect((await deleteReminder(scope(), 'r1')).ok).toBe(true);

    expect(bucket()).toEqual([elsewhere]);
  });
});
