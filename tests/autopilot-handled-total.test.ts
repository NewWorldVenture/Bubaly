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
  slots: [] as unknown[], cursor: 0, mount: undefined as (() => void) | undefined,
  db: null as unknown,
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => { harness.slots[index] = next; }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => { harness.mount = effect; },
  useTransition: () => [false, (callback: () => void) => callback()],
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', role: 'parent' }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => harness.db }));
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

describe('Autopilot handled total', () => {
  it('shows all non-run contributions, matching time-saved for the same family and week', async () => {
    mountPanel();
    const saved = await loadTimeSaved(db, 'family-1', NOW);
    expect(saved).toMatchObject({ available: true, data: { actions: 3, minutes: 11 } });
    await vi.waitFor(() => expect(renderPanel()).toContain('3 handled for you this week'));
  });

  it.each(['autopilot_suggestions', 'agent_activity', 'family_reminders'])('shows unavailable when %s fails', async (table) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      if (name === table) {
        return { select: () => ({ eq: () => ({ eq: () => ({ gte: () => Promise.resolve({ count: null, error: { message: 'unavailable' } }) }) }) }) };
      }
      return original(name as never);
    }) as typeof db.from);
    mountPanel();
    await vi.waitFor(() => expect(renderPanel()).toContain('We could not read what Bubaly handled this week.'));
    expect(renderPanel()).not.toContain('handled for you this week');
    expect(await loadTimeSaved(db, 'family-1', NOW)).toEqual({ available: false });
  });
});
