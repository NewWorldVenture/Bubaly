import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { resetHookSlots } from './helpers/hook-slots';
import { byName, click as clickButton, render } from './helpers/module-harness';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';

// Real RemindersModule handlers, useAction, recurrence calculations, origin
// reader and strict atomic RPC model. Hook slots/UI/realtime delivery are
// modelled; refresh invokes the component's real fetcher. This is not a DOM,
// native PostgreSQL concurrency, live provider or full session-boundary test.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const pendingRefreshes = vi.hoisted(() => new Set<Promise<void>>());
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const query = (await import('./helpers/module-harness')).realtimeQueryModule(h);
  return {
    useRealtimeQuery: (...args: Parameters<typeof query.useRealtimeQuery>) => {
      const result = query.useRealtimeQuery(...args);
      return { ...result, refresh: () => {
        const pending = result.refresh();
        pendingRefreshes.add(pending);
        void pending.then(() => pendingRefreshes.delete(pending), () => pendingRefreshes.delete(pending));
        return pending;
      } };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/media/family-media-img', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({
  createReminderAction: vi.fn(() => { throw new Error('Unexpected create action'); }),
  deleteReminderAction: vi.fn(() => { throw new Error('Unexpected delete action'); }),
  snoozeReminderAction: vi.fn(() => { throw new Error('Unexpected snooze action'); }),
}));

const { RemindersModule } = await import('@/components/modules/reminders-module');
const FAMILY = h.app.familyId;
const USER = h.app.userId;
const PARENT = '10000000-0000-4000-8000-000000000001';
const CARD = '20000000-0000-4000-8000-000000000001';
const NOW = '2026-10-14T12:00:00.000Z';
const DUE = '2026-10-14T14:30:00.000Z';
const NEXT = '2026-10-15T14:30:00.000Z';
const PARTIAL = 'Reminder completed, but we could not confirm the next occurrence. Check your reminders before adding another.';
const t = (key: string) => translate(SOURCE_MESSAGES, key);
type Memory = ReturnType<typeof createInMemorySupabase>;
type Reply = Awaited<ReturnType<Memory['rpc']>>;
type Fault =
  | { kind: 'returned'; code: string; message?: string }
  | { kind: 'throw' | 'commit-lost' }
  | { kind: 'receipt'; receipt: Record<string, unknown> | null };
let db: Memory;
let faults: Fault[];
let successorAttempts: number;
let writes: { operation: string; payload: unknown }[];
let parentRefusal: boolean;

async function click(button: Parameters<typeof clickButton>[0]) {
  await clickButton(button);
  // Generated-origin refresh includes async digest work. Await its actual
  // completion, not one arbitrary timer tick, before checking the screen or
  // allowing the next case to replace the shared harness state.
  await Promise.all([...pendingRefreshes]);
}

const refused = (code: string, message = 'Synthetic write refused'): Reply => ({
  data: null, count: null, error: { code, message, details: null, hint: null }, status: 400, statusText: 'Bad Request',
});

// Faults are at an explicit response boundary. A lost response first executes
// the actual helper write, verifies it committed, then rejects. No permissive
// seed defaults or catch-all RPC overrides manufacture origin authority.
async function successor(proceed: () => PromiseLike<Reply>): Promise<Reply> {
  successorAttempts++;
  const fault = faults.shift();
  if (fault?.kind === 'returned') return refused(fault.code, fault.message);
  if (fault?.kind === 'throw') throw new Error('Synthetic transport failure before successor commit');
  const result = await proceed();
  if (fault?.kind === 'commit-lost') {
    expect(result.error).toBeNull();
    expect(db.table('family_reminders')).toHaveLength(2);
    throw new Error('Synthetic response lost after successor commit');
  }
  if (fault?.kind === 'receipt') {
    expect(result.error).toBeNull();
    return { ...result, data: fault.receipt };
  }
  return result;
}

function instrument() {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const target = from(table);
    let operation = 'read';
    let once: Promise<Reply> | undefined;
    const proxy: typeof target = new Proxy(target, {
      get(object, property) {
        if (property === 'then') return (resolve: (reply: Reply) => unknown, reject: (error: unknown) => unknown) => {
          once ??= table === 'family_reminders' && operation === 'insert'
            ? successor(() => object)
            : table === 'family_reminders' && operation === 'update' && parentRefusal
              ? Promise.resolve(refused('42501')) : Promise.resolve(object);
          return once.then(resolve, reject);
        };
        const value = Reflect.get(object, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['insert', 'update', 'delete', 'upsert'].includes(String(property))) {
            operation = String(property);
            writes.push({ operation, payload: args[0] });
          }
          const result = Reflect.apply(value, object, args);
          return result === object ? proxy : result;
        };
      },
    });
    return proxy;
  });
  const rpc = db.rpc.bind(db);
  vi.spyOn(db, 'rpc').mockImplementation((name, args) => {
    if (name !== 'repeat_card_family_reminder') return rpc(name, args);
    const request = successor(() => rpc(name, args).maybeSingle());
    return Object.assign(request, { maybeSingle: () => request, single: () => request });
  });
}

beforeEach(() => {
  expect(pendingRefreshes.size).toBe(0);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ userId: USER, rpcRole: 'authenticated', uniques: { family_reminders: [['family_id', 'idempotency_key']] } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  (h.app as Record<string, unknown>).role = 'parent';
  faults = []; successorAttempts = 0; writes = []; parentRefusal = false;
  db.seed('families', [{ id: FAMILY }]);
  db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, user_id: USER, role: 'parent', is_active: true }]);
  instrument();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function seed(generated: boolean, recurrence = 'daily') {
  db.seed('family_reminders', [{
    id: PARENT, family_id: FAMILY, created_by: USER, title: 'Synthetic recurring task', notes: null,
    kind: 'time', priority: 'medium', recurrence, remind_at: DUE, status: 'active',
    completed_at: null, snoozed_until: null, member_id: null, assigned_to_id: null,
    location_name: null, url: null, flagged: false, early_reminder_minutes: 0, image_url: null,
    subtasks: [{ id: 'step-1', title: 'Synthetic step', done: true }], list_id: null, tags: [],
    autopilot_origin: generated, autopilot_card_id: generated ? CARD : null,
  }]);
  if (generated) db.seed('autopilot_suggestions', [{
    id: CARD, family_id: FAMILY, member_id: null, kind: 'renewal', action_type: 'create_reminder',
    title: 'Synthetic source card', status: 'executed', payload: {}, expires_at: null,
  }]);
  return byName(render(h.hooks, createElement(RemindersModule)), t('remindersModule.markComplete'), 'button');
}

function assertParentCommitted() {
  expect(db.table('family_reminders').find((row) => row.id === PARENT)).toMatchObject({
    status: 'completed', completed_at: NOW, autopilot_origin: expect.any(Boolean),
  });
  expect(writes.filter((write) => write.operation === 'update')).toEqual([
    { operation: 'update', payload: { status: 'completed', completed_at: NOW } },
  ]);
  expect(writes.some((write) => ['delete', 'upsert'].includes(write.operation))).toBe(false);
}

function assertPartial(attempts: number, childCount: number) {
  assertParentCommitted();
  expect.soft(successorAttempts).toBe(attempts);
  expect.soft(db.table('family_reminders')).toHaveLength(childCount + 1);
  expect.soft(h.toasts.success).toEqual([]);
  expect.soft(h.toasts.error).toEqual([PARTIAL]);
  expect.soft(h.refreshes).toEqual(['family_reminders']);
  expect.soft(h.rows.family_reminders.find((row) => row.id === PARENT)?.status).toBe('completed');
  expect.soft(h.rows.family_reminders).toHaveLength(childCount + 1);
  expect(faults).toEqual([]);
}

describe('reminder completion crosses a separate successor write boundary', () => {
  for (const generated of [false, true]) {
    const origin = generated ? 'generated' : 'manual';
    it(`${origin}: healthy one-off completes once without a successor`, async () => {
      await click(seed(generated, 'none'));
      assertParentCommitted();
      expect(successorAttempts).toBe(0);
      expect(db.table('family_reminders')).toHaveLength(1);
      expect(h.toasts).toEqual({ success: ['Reminder completed ✓'], error: [] });
      expect(h.refreshes).toEqual(['family_reminders']);
    });

    it(`${origin}: healthy recurrence confirms one new occurrence`, async () => {
      await click(seed(generated));
      assertParentCommitted();
      expect(successorAttempts).toBe(1);
      expect(db.table('family_reminders')).toHaveLength(2);
      expect(db.table('family_reminders').find((row) => row.id !== PARENT)).toMatchObject({
        family_id: FAMILY, status: 'active', remind_at: NEXT,
        autopilot_origin: generated, autopilot_card_id: generated ? CARD : null,
        subtasks: [{ id: 'step-1', title: 'Synthetic step', done: false }],
      });
      expect(h.toasts).toEqual({ success: ['Completed ✓ — next one scheduled'], error: [] });
      expect(h.refreshes).toEqual(['family_reminders']);
    });

    for (const fault of [
      { kind: 'returned', code: '42501' }, { kind: 'throw' }, { kind: 'commit-lost' },
    ] as const) {
      it(`${origin}: ${fault.kind} after completion reports uncertainty and refreshes without rollback or retry`, async () => {
        faults = [fault];
        await click(seed(generated));
        assertPartial(1, fault.kind === 'commit-lost' ? 1 : 0);
      });
    }

    it(`${origin}: zero-row parent completion cannot schedule a successor or announce completion`, async () => {
      const button = seed(generated);
      db.replace('family_reminders', []); // The mounted list is now stale.
      await click(button);
      expect(successorAttempts).toBe(0);
      expect(db.table('family_reminders')).toEqual([]);
      expect(h.toasts).toEqual({ success: [], error: [t('errors.thatChangeWasNotSaved')] });
      expect(h.refreshes).toEqual(['family_reminders']);
      expect(h.rows.family_reminders).toEqual([]);
    });

    it(`${origin}: refused parent completion leaves the active row and creates no successor`, async () => {
      parentRefusal = true;
      await click(seed(generated));
      expect(successorAttempts).toBe(0);
      expect(db.table('family_reminders')).toHaveLength(1);
      expect(db.table('family_reminders')[0]).toMatchObject({ status: 'active', completed_at: null });
      expect(h.toasts.success).toEqual([]);
      expect(h.toasts.error).toHaveLength(1);
      expect(h.toasts.error[0]).not.toBe(PARTIAL);
    });
  }

  for (const [label, receipt] of [
    ['empty', null],
    ['missing id', { family_id: FAMILY, autopilot_origin: true, autopilot_card_id: CARD }],
    ['empty id', { id: '', family_id: FAMILY, autopilot_origin: true, autopilot_card_id: CARD }],
    ['wrong family', { id: 'receipt', family_id: 'other-family', autopilot_origin: true, autopilot_card_id: CARD }],
    ['wrong origin', { id: 'receipt', family_id: FAMILY, autopilot_origin: false, autopilot_card_id: CARD }],
    ['wrong card', { id: 'receipt', family_id: FAMILY, autopilot_origin: true, autopilot_card_id: 'other-card' }],
  ] as const) {
    it(`generated: ${label} receipt cannot confirm the committed successor`, async () => {
      faults = [{ kind: 'receipt', receipt }];
      await click(seed(true));
      assertPartial(1, 1);
    });
  }

  for (const code of ['PGRST204', 'PGRST205', '42P01', '42703']) {
    it(`manual: definite ${code} schema refusal permits exactly the existing stripped-column fallback`, async () => {
      faults = [{ kind: 'returned', code }];
      await click(seed(false));
      assertParentCommitted();
      expect(successorAttempts).toBe(2);
      expect(db.table('family_reminders')).toHaveLength(2);
      expect(h.toasts).toEqual({ success: ['Completed ✓ — next one scheduled'], error: [] });
      expect(h.refreshes).toEqual(['family_reminders']);
      const inserts = writes.filter((write) => write.operation === 'insert');
      expect(inserts).toHaveLength(2);
      expect(inserts[0].payload).toHaveProperty('subtasks');
      for (const column of ['url', 'flagged', 'early_reminder_minutes', 'image_url', 'subtasks', 'list_id']) {
        expect(inserts[1].payload).not.toHaveProperty(column);
      }
    });
  }

  for (const code of ['', 'FETCH_ERROR']) {
    it(`manual: uncertain ${code || 'empty-code'} schema-like error cannot authorize a retry`, async () => {
      faults = [{ kind: 'returned', code, message: 'column synthetic_field does not exist; response unavailable' }];
      await click(seed(false));
      assertPartial(1, 0);
    });
  }

  for (const second of [{ kind: 'returned', code: '42501' }, { kind: 'throw' }, { kind: 'commit-lost' }] as const) {
    it(`manual: ${second.kind} on the permitted fallback still reports partial completion`, async () => {
      faults = [{ kind: 'returned', code: 'PGRST204' }, second];
      await click(seed(false));
      assertPartial(2, second.kind === 'commit-lost' ? 1 : 0);
    });
  }

  it('the harness retains unknown RPC refusal rather than fabricating writer authority', async () => {
    const result = await db.rpc('synthetic_unknown_rpc', {}).maybeSingle();
    expect(result.error?.code).toBe('42883');
    expect(successorAttempts).toBe(0);
    expect(db.table('family_reminders')).toEqual([]);
  });
});
