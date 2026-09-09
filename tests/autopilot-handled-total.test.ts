import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { AutopilotPanel } from '@/components/concierge/autopilot-panel';
import { loadTimeSaved } from '@/lib/metric/time-saved-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// Exercise the real panel's mount/read/render path with simulated hooks and
// Supabase rows. No browser or DOM is involved; the metric itself is not mocked.
const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, mount: undefined as (() => void | (() => void)) | undefined,
  db: null as unknown, familyId: 'family-1', clientError: false,
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => { harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { harness.mount = effect; },
  useTransition: () => [false, (callback: () => void) => callback()],
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: harness.familyId, role: 'parent' }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => {
  if (harness.clientError) throw new Error('client construction failed');
  return harness.db;
} }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/app/(app)/dashboard/concierge/actions', () => ({
  dismissQueuedRunAction: vi.fn(), executeQueuedRunAction: vi.fn(), setConciergeAutopilotAction: vi.fn(),
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const NOW = new Date('2026-03-15T12:00:00.000Z');
const IN_WEEK = '2026-03-12T09:00:00.000Z';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

function renderPanel(): string {
  harness.cursor = 0;
  return textOf(AutopilotPanel({}));
}

function mountPanel() {
  expect(renderPanel()).toBe('');
  harness.mount!();
}

beforeEach(() => {
  // Only freeze Date; vi.waitFor keeps real timers for the async query chain.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  harness.slots = [];
  harness.mount = undefined;
  harness.familyId = 'family-1';
  harness.clientError = false;
  db = createInMemorySupabase<SupabaseClient<Database>>();
  harness.db = db;
  db.seed('agent_activity', [
    { id: 'activity', family_id: 'family-1', status: 'done', created_at: IN_WEEK },
    { id: 'other', family_id: 'family-2', status: 'done', created_at: IN_WEEK },
    { id: 'old', family_id: 'family-1', status: 'done', created_at: '2026-02-01T12:00:00.000Z' },
  ]);
  db.seed('autopilot_suggestions', [{ id: 'suggestion', family_id: 'family-1', status: 'auto_executed', created_at: IN_WEEK }]);
  db.seed('family_reminders', [{ id: 'reminder', family_id: 'family-1', status: 'completed', updated_at: IN_WEEK }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Autopilot recorded completed plans', () => {
  it('shows the same dated subset and undated coverage as the planning-time model', async () => {
    db.seed('family_automation_runs', [
      { id: 'complete', family_id: 'family-1', state: 'completed', status: 'executed', created_at: IN_WEEK, completed_at: IN_WEEK },
      { id: 'undated', family_id: 'family-1', state: 'completed', status: 'executed', created_at: IN_WEEK, completed_at: null },
      { id: 'partial', family_id: 'family-1', state: 'partially_completed', status: 'executed', created_at: IN_WEEK, completed_at: IN_WEEK },
    ]);
    mountPanel();
    expect(await loadTimeSaved(db, 'family-1', NOW)).toMatchObject({ available: true, data: { actions: 1, minutes: 12, undatedCompletedRuns: 1 } });
    await vi.waitFor(() => expect(renderPanel()).toContain('1 recorded plans completed in the last 7 days'));
    expect(renderPanel()).toContain('1 completed plans have no completion date');
  });

  it('does not claim the broader non-run activity was completed plans', async () => {
    mountPanel();
    await vi.waitFor(() => expect(renderPanel()).toContain('0 recorded plans completed in the last 7 days'));
    expect(await loadTimeSaved(db, 'family-1', NOW)).toMatchObject({ available: true, data: { actions: 0, minutes: 0 } });
  });

  it('shows unavailable when the completion count cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      if (name === 'family_automation_runs') throw new Error('unavailable');
      return original(name as never);
    }) as typeof db.from);
    mountPanel();
    await vi.waitFor(() => expect(renderPanel()).toContain('We could not read the recorded completed plans.'));
    expect(renderPanel()).not.toContain('plans completed in the last 7 days');
    expect(await loadTimeSaved(db, 'family-1', NOW)).toEqual({ available: false });
  });

  it('hides the old household immediately and ignores its pending read after switching', async () => {
    db.seed('family_automation_runs', [{
      id: 'old-family-plan', family_id: 'family-1', state: 'completed', status: 'executed',
      trigger_type: 'plan_accepted', summary: 'Private old household plan', created_at: IN_WEEK, completed_at: IN_WEEK,
    }]);
    mountPanel();
    await vi.waitFor(() => expect(renderPanel()).toContain('1 recorded plans completed'));
    harness.cursor = 0;
    const panel = AutopilotPanel({})!;
    const header = panel.props.children[0];
    header.props.onClick();
    expect(renderPanel()).toContain('Private old household plan');

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const from = db.from.bind(db);
    let delay = true;
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table as never);
      if (delay) {
        const then = query.then.bind(query);
        query.then = ((fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) =>
          pending.then(() => then(fulfilled, rejected))) as typeof query.then;
      }
      return query;
    }) as typeof db.from);
    const oldCleanup = harness.mount!();
    // Allow the metric's deferred query builders to join the pending old read.
    await Promise.resolve();
    await Promise.resolve();
    harness.familyId = 'family-2';
    expect(renderPanel()).toBe('');
    if (typeof oldCleanup === 'function') oldCleanup();
    delay = false;
    harness.mount!();
    await vi.waitFor(() => expect(renderPanel()).toContain('0 recorded plans completed'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderPanel()).toContain('0 recorded plans completed');
    expect(renderPanel()).not.toContain('1 recorded plans completed');
    expect(renderPanel()).not.toContain('Private old household plan');
  });

  it('renders client construction failure as unavailable with a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.clientError = true;
    mountPanel();
    await vi.waitFor(() => expect(renderPanel()).toContain('We could not read the recorded completed plans.'));
    harness.cursor = 0;
    const panel = AutopilotPanel({})!;
    panel.props.children[0].props.onClick();
    expect(renderPanel()).toContain('Try again');
    expect(renderPanel()).not.toContain('0 recorded plans completed');
  });
});
