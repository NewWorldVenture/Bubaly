import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
const harness = vi.hoisted(() => ({
  familyId: 'ours', slots: [] as unknown[], cursor: 0,
  mount: undefined as (() => void | (() => void)) | undefined,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: harness.familyId, role: 'parent' }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => { harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next; }];
  },
  useEffect: (effect: () => void | (() => void)) => { harness.mount = effect; },
}));

const { loadFamilyDeliveredValueAction } = await import('@/app/(app)/dashboard/billing/value-actions');
const { FamilyDeliveredValue, DeliveredValueSummary } = await import('@/components/billing/family-delivered-value');
const { UpgradeModal } = await import('@/components/app/upgrade-modal');
const NOW = new Date('2026-09-09T12:00:00Z');
const IN_WEEK = '2026-09-08T12:00:00Z';
let db: ReturnType<typeof createInMemorySupabase>;

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function containsValue(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(containsValue);
  if (!isValidElement<{ children?: ReactNode }>(node)) return false;
  return node.type === FamilyDeliveredValue || containsValue(node.props.children);
}
function renderValue() {
  harness.cursor = 0;
  const element = FamilyDeliveredValue();
  return textOf(DeliveredValueSummary(element.props));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  harness.familyId = 'ours';
  harness.slots = [];
  harness.cursor = 0;
  harness.mount = undefined;
  db = createInMemorySupabase();
  mocks.requireUserContext.mockResolvedValue({ active: { familyId: 'ours' } });
  mocks.createServer.mockResolvedValue(db);
  db.seed('family_automation_runs', [{ id: 'run', family_id: 'ours', state: 'completed', status: 'executed', created_at: IN_WEEK }]);
  db.seed('autopilot_suggestions', [{ id: 'auto', family_id: 'ours', status: 'auto_executed', created_at: IN_WEEK }]);
  db.seed('agent_activity', [
    { id: 'done', family_id: 'ours', status: 'done', created_at: IN_WEEK },
    { id: 'foreign', family_id: 'theirs', status: 'done', created_at: IN_WEEK },
    { id: 'old', family_id: 'ours', status: 'done', created_at: '2026-08-01T12:00:00Z' },
    { id: 'unfinished', family_id: 'ours', status: 'pending', created_at: IN_WEEK },
  ]);
  db.seed('family_reminders', [{ id: 'sent', family_id: 'ours', status: 'completed', updated_at: IN_WEEK }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('personal delivered value read boundary', () => {
  it('derives the family from the session and counts only its handled work in the last seven days', async () => {
    const snapshot = await loadFamilyDeliveredValueAction();
    expect(snapshot).toMatchObject({ familyId: 'ours', result: { available: true, data: { actions: 4, minutes: 23 } } });
    expect(mocks.requireUserContext).toHaveBeenCalledOnce();
    expect(mocks.createServer).toHaveBeenCalledOnce();
  });

  it('does not read household value before authentication succeeds', async () => {
    const redirect = new Error('NEXT_REDIRECT');
    mocks.requireUserContext.mockRejectedValue(redirect);
    await expect(loadFamilyDeliveredValueAction()).rejects.toBe(redirect);
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });

  it.each(['family_automation_runs', 'autopilot_suggestions', 'agent_activity', 'family_reminders'])('keeps a failed %s count distinct from zero', async (table) => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      if (name !== table) return from(name);
      const failed = {
        select: () => failed, eq: () => failed, or: () => failed,
        gte: () => Promise.resolve({ count: null, error: { message: 'unavailable' } }),
      };
      return failed;
    }) as typeof db.from);
    expect(await loadFamilyDeliveredValueAction()).toEqual({ familyId: 'ours', result: { available: false } });
    expect(console.error).toHaveBeenCalled();
  });

  it('handles a transport/client failure without inventing a zero', async () => {
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('offline'); });
    expect(await loadFamilyDeliveredValueAction()).toEqual({ familyId: 'ours', result: { available: false } });
    expect(console.error).toHaveBeenCalledWith('[billing-value] handled work read failed', expect.any(Error));
  });

  it('renders unavailable when an otherwise successful exact count is missing', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      if (name !== 'family_reminders') return from(name);
      const incomplete = {
        select: () => incomplete, eq: () => incomplete,
        gte: () => Promise.resolve({ count: null, error: null }),
      };
      return incomplete;
    }) as typeof db.from);
    const snapshot = await loadFamilyDeliveredValueAction();
    expect(snapshot).toEqual({ familyId: 'ours', result: { available: false } });
    renderValue();
    harness.mount!();
    await vi.waitFor(() => expect(renderValue()).toContain('could not read'));
    expect(renderValue()).toContain('Try again');
    expect(renderValue()).not.toContain('Things handled');
    expect(renderValue()).not.toContain('0 min');
    expect(renderValue()).not.toContain('No work recorded as handled');
  });
});

describe('upgrade and billing value presentation', () => {
  it('shows actual work and an explicitly estimated duration through the real action', async () => {
    expect(renderValue()).toContain('Loading');
    harness.mount!();
    await vi.waitFor(() => expect(renderValue()).toContain('23 min'));
    const text = renderValue();
    expect(text).toContain('Things handled 4');
    expect(text).toContain('last 7 days');
    expect(text).toContain('Estimated time saved');
    expect(text).toContain('Estimated from recorded work');
    expect(text).not.toMatch(/\$|ROI|this month|verified savings/i);
  });

  it('shows a true quiet week separately from unavailable data', async () => {
    for (const table of ['family_automation_runs', 'autopilot_suggestions', 'agent_activity', 'family_reminders']) db.replace(table, []);
    const snapshot = await loadFamilyDeliveredValueAction();
    const zero = textOf(DeliveredValueSummary({ result: snapshot.result, onRetry: vi.fn() }));
    expect(zero).toContain('Things handled 0');
    expect(zero).toContain('No work recorded as handled');
    expect(zero).toContain('0 min');
    const unavailable = textOf(DeliveredValueSummary({ result: { available: false }, onRetry: vi.fn() }));
    expect(unavailable).toContain('could not read');
    expect(unavailable).toContain('Try again');
    expect(unavailable).not.toContain('Things handled 0');
  });

  it('drops prior household data immediately and rejects a response for a different active household', async () => {
    renderValue();
    const cleanup = harness.mount!();
    await vi.waitFor(() => expect(renderValue()).toContain('23 min'));
    if (typeof cleanup === 'function') cleanup();
    harness.familyId = 'theirs';
    expect(renderValue()).toContain('Loading');
    expect(renderValue()).not.toContain('23 min');
    harness.mount!();
    await vi.waitFor(() => expect(renderValue()).toContain('could not read'));
    expect(renderValue()).not.toContain('23 min');
  });

  it('does not mount the value loader inside a closed upgrade modal', () => {
    expect(containsValue(UpgradeModal({ open: false, onClose: vi.fn() }))).toBe(false);
    harness.cursor = 0;
    expect(containsValue(UpgradeModal({ open: true, onClose: vi.fn() }))).toBe(true);
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
  });
});
