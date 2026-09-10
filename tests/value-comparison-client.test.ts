import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FamilyValueSnapshot } from '@/app/(app)/dashboard/billing/value-comparison-actions';

const harness = vi.hoisted(() => ({
  familyId: 'ours', slots: [] as unknown[], cursor: 0, action: vi.fn(),
  mount: undefined as (() => void | (() => void)) | undefined,
}));
vi.mock('@/app/(app)/dashboard/billing/value-comparison-actions', () => ({ loadFamilyValueComparisonAction: harness.action }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: harness.familyId }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    useLocale: () => ({ code: 'en-US' }),
  };
});
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useId: () => 'hourly',
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => { harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next; }];
  },
  useEffect: (effect: () => void | (() => void)) => { harness.mount = effect; },
}));

const { FamilyValueComparison, ValueComparisonSummary } = await import('@/components/billing/family-value-comparison');
const snapshot: FamilyValueSnapshot = { familyId: 'ours', result: { state: 'available', completedRuns: 2, undatedCompletedRuns: 0, annualListCents: 11988 } };
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function findInput(node: ReactNode): { onChange: (event: { target: { value: string } }) => void } | undefined {
  if (Array.isArray(node)) return node.map(findInput).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onChange: (event: { target: { value: string } }) => void }>(node)) return;
  if (node.type === 'input') return node.props;
  return findInput(node.props.children);
}
function render(initial?: FamilyValueSnapshot) {
  harness.cursor = 0;
  return ValueComparisonSummary(FamilyValueComparison({ initial }).props);
}
beforeEach(() => {
  harness.familyId = 'ours'; harness.slots = []; harness.cursor = 0; harness.mount = undefined;
  harness.action.mockReset().mockResolvedValue(snapshot);
});

describe('value estimate interaction', () => {
  it('uses the server Home snapshot without a duplicate read and updates only the local estimate', () => {
    expect(textOf(render(snapshot))).toContain('$10.00');
    harness.mount!();
    expect(harness.action).not.toHaveBeenCalled();
    findInput(render(snapshot))!.onChange({ target: { value: '50' } });
    expect(textOf(render(snapshot))).toContain('$20.00');
    expect(harness.action).not.toHaveBeenCalled();
    findInput(render(snapshot))!.onChange({ target: { value: '' } });
    expect(textOf(render(snapshot))).toContain('Enter an hourly value');
    expect(textOf(render(snapshot))).not.toContain('$0.00');
    findInput(render(snapshot))!.onChange({ target: { value: '0' } });
    expect(textOf(render(snapshot))).toContain('$0.00');
  });
  it('hides old household figures immediately and rejects a differently scoped response', async () => {
    render();
    const cleanup = harness.mount!();
    await vi.waitFor(() => expect(textOf(render())).toContain('$10.00'));
    if (typeof cleanup === 'function') cleanup();
    harness.familyId = 'theirs';
    expect(textOf(render())).toContain('Loading');
    expect(textOf(render())).not.toContain('$10.00');
    harness.mount!();
    await vi.waitFor(() => expect(textOf(render())).toContain('could not read'));
    expect(textOf(render())).not.toContain('$10.00');
  });
  it('ignores an older request that settles after switching households', async () => {
    let resolveFirst!: (value: FamilyValueSnapshot) => void;
    harness.action.mockReturnValueOnce(new Promise<FamilyValueSnapshot>((resolve) => { resolveFirst = resolve; }));
    render();
    const cleanup = harness.mount!();
    if (typeof cleanup === 'function') cleanup();
    harness.familyId = 'theirs';
    harness.action.mockResolvedValue({ familyId: 'theirs', result: { state: 'ineligible' } });
    render(); harness.mount!();
    await vi.waitFor(() => expect(textOf(render())).toBe(''));
    resolveFirst(snapshot);
    await Promise.resolve();
    expect(textOf(render())).toBe('');
  });
});
