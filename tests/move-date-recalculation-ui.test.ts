import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoveDateRecalculation } from '@/components/modules/move-date-recalculation';
import {
  addMoveDays, isMoveDate, isMoveDatePreview, isMoveDateResult, moveDateContextKey,
  type MoveDatePreview, type MoveDateResult, type MoveDateReviewContext, type MoveDateTask,
} from '@/lib/moving/recalculation';

// Hook/UI acceptance only: real panel, validators and element props; simulated hooks,
// fetch, UUIDs and keyed mounts. This does not exercise a browser, DOM or database.
type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
const mocks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, dirty: false, key: null as string | null,
  effects: [] as (() => void)[], cleanups: new Set<() => void>(),
  fetch: vi.fn(), uuid: vi.fn(), onClose: vi.fn(), onSaved: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    const slots = mocks.slots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => {
      const next = typeof value === 'function' ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) {
        slots[index] = next;
        mocks.dirty = true;
      }
    }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  // The panel calls `useTranslations()`, which reads a context. This harness
  // invokes the component as a plain function, so there is no React dispatcher
  // and the real `useContext` throws. Returning undefined is the honest stand-in
  // for "rendered outside a LocaleProvider": `useTranslations` then falls back
  // through `translate({}, key)` to SOURCE_MESSAGES, so the panel renders its
  // ENGLISH copy — which is exactly what the assertions below are written
  // against, and what a user would see if the provider were ever missing.
  useContext: () => undefined,
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = mocks.cursor++;
    const slots = mocks.slots;
    const previous = slots[index] as Effect | undefined;
    if (previous?.deps && deps && previous.deps.length === deps.length
      && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    mocks.effects.push(() => {
      if (previous?.cleanup) {
        previous.cleanup();
        mocks.cleanups.delete(previous.cleanup);
      }
      const cleanup = effect();
      slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      if (typeof cleanup === 'function') mocks.cleanups.add(cleanup);
    });
  },
}));

const context: MoveDateReviewContext = {
  familyId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  memberId: '33333333-3333-4333-8333-333333333333',
  role: 'parent', active: true,
};
const move = {
  id: '44444444-4444-4444-8444-444444444444',
  move_date: '2026-09-20', updated_at: '2026-09-06T12:00:00.000Z', status: 'planning',
};
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEXT_REQUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_DATE = '2026-10-04';
const LATER_DATE = '2026-10-11';
const REVIEW = 'Review date change';
const APPLY = 'Apply reviewed date change';

function task(index: number, title: string, patch: Partial<MoveDateTask> = {}): MoveDateTask {
  return {
    id: '55555555-5555-4555-8555-' + String(index).padStart(12, '0'),
    title, status: 'todo', mode: 'relative', offsetDays: -7,
    dueDate: '2026-09-13', nextDueDate: '2026-09-27', updatedAt: move.updated_at,
    action: 'shift', reason: 'relative', ...patch,
  };
}
function preview(patch: Partial<MoveDatePreview> = {}): MoveDatePreview {
  return {
    version: 1, familyId: context.familyId, memberId: context.memberId!, moveId: move.id,
    fromDate: move.move_date, toDate: NEW_DATE, moveUpdatedAt: move.updated_at,
    tasks: [
      task(1, 'Pack moving boxes'),
      task(2, 'Meet the movers', {
        status: 'doing', offsetDays: 0, dueDate: move.move_date, nextDueDate: NEW_DATE,
      }),
      task(3, 'Fixed inspection', {
        mode: 'fixed', dueDate: '2026-09-14', nextDueDate: '2026-09-14',
        action: 'preserve', reason: 'fixed',
      }),
      task(4, 'Completed utility setup', {
        status: 'done', nextDueDate: '2026-09-13', action: 'preserve', reason: 'completed',
      }),
      task(5, 'Skipped donation pickup', {
        status: 'skipped', nextDueDate: '2026-09-13', action: 'preserve', reason: 'skipped',
      }),
      task(6, 'Undated packing reminder', {
        dueDate: null, nextDueDate: null, action: 'preserve', reason: 'no_date',
      }),
      task(7, 'Manually rescheduled cleaning', {
        dueDate: '2026-09-12', nextDueDate: '2026-09-12', action: 'preserve', reason: 'out_of_sync',
      }),
    ],
    changes: 2, ...patch,
  };
}
function previewResult(snapshot = preview()): MoveDateResult {
  return { preview: snapshot, applied: false, requestId: null, appliedAt: null };
}
function appliedResult(snapshot = preview(), requestId = REQUEST_ID): MoveDateResult {
  return { preview: snapshot, applied: true, requestId, appliedAt: '2026-09-06T12:05:00.000Z' };
}
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render<T>(factory: () => T): T {
  for (let pass = 0; pass < 8; pass += 1) {
    mocks.cursor = 0;
    mocks.dirty = false;
    const result = factory();
    mocks.effects.splice(0).forEach((effect) => effect());
    if (!mocks.dirty) return result;
  }
  throw new Error('Hook harness did not settle within eight renders');
}
function unmount() {
  mocks.cleanups.forEach((cleanup) => cleanup());
  mocks.cleanups.clear();
  mocks.effects = [];
  mocks.slots = [];
  mocks.key = null;
  mocks.dirty = false;
}
function panel(ctx = context, target = move, key = 'panel') {
  if (mocks.key !== key) {
    unmount();
    mocks.key = key;
  }
  return render(() => MoveDateRecalculation({
    context: ctx, move: target, onClose: mocks.onClose, onSaved: mocks.onSaved,
  }));
}
function button(tree: ReactNode, label: string): Node {
  const match = nodes(tree).find((node) =>
    typeof node.props.onClick === 'function' && textOf(node) === label);
  expect(match, 'Button: ' + label).toBeDefined();
  return match!;
}
function input(tree: ReactNode): Node {
  const match = nodes(tree).find((node) => node.props['aria-label'] === 'New move date');
  expect(match, 'Date-only input').toBeDefined();
  return match!;
}
function reviewed(tree: ReactNode): Node | undefined {
  return nodes(tree).find((node) => node.props['aria-label'] === 'Reviewed deadline changes');
}
function edit(field: Node, value: string) {
  (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
// Calling handlers directly also lets us exercise guards independently of disabled props.
function click(tree: ReactNode, label: string): Promise<void> {
  return Promise.resolve((button(tree, label).props.onClick as () => void | Promise<void>)());
}
function options(index = mocks.fetch.mock.calls.length - 1): RequestInit {
  return mocks.fetch.mock.calls[index][1] as RequestInit;
}
type Body = {
  familyId: string; memberId: string; moveId: string; date: string;
  expected?: MoveDatePreview; requestId?: string;
};
function body(index = mocks.fetch.mock.calls.length - 1): Body {
  return JSON.parse(options(index).body as string) as Body;
}
async function reviewedPanel(snapshot = preview(), ctx = context, target = move, key = 'panel') {
  expect(isMoveDatePreview(snapshot)).toBe(true);
  expect(isMoveDateResult(previewResult(snapshot))).toBe(true);
  let tree = panel(ctx, target, key);
  edit(input(tree), snapshot.toDate);
  tree = panel(ctx, target, key);
  mocks.fetch.mockResolvedValueOnce(response(previewResult(snapshot)));
  await click(tree, REVIEW);
  tree = panel(ctx, target, key);
  expect(reviewed(tree)).toBeDefined();
  expect(button(tree, APPLY).props.disabled).toBe(false);
  return tree;
}

beforeEach(() => {
  unmount();
  mocks.fetch.mockReset();
  mocks.uuid.mockReset().mockReturnValue(REQUEST_ID);
  mocks.onClose.mockReset();
  mocks.onSaved.mockReset();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('crypto', { randomUUID: mocks.uuid });
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('move date recalculation hook/UI acceptance (no browser or database)', () => {
  it('only requests a preview on the review button, with no expected snapshot or request UUID', async () => {
    let tree = panel();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(input(tree).props).toMatchObject({
      type: 'date', value: move.move_date, min: '0001-01-01', max: '9999-12-31',
    });
    expect(button(tree, REVIEW).props.disabled).toBe(true);
    expect(button(tree, APPLY).props.disabled).toBe(true);
    edit(input(tree), LATER_DATE);
    tree = panel();
    edit(input(tree), NEW_DATE);
    tree = panel();
    expect(input(tree).props.value).toBe(NEW_DATE);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await click(tree, APPLY);
    expect(mocks.fetch).not.toHaveBeenCalled();

    const pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const first = click(tree, REVIEW);
    await click(tree, REVIEW);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/moving/recalculate');
    expect(options()).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(options().signal).toBeInstanceOf(AbortSignal);
    expect(body()).toEqual({
      familyId: context.familyId, memberId: context.memberId, moveId: move.id, date: NEW_DATE,
    });
    expect(mocks.uuid).not.toHaveBeenCalled();
    tree = panel();
    expect(input(tree).props.disabled).toBe(true);
    expect(button(tree, REVIEW).props.disabled).toBe(true);
    expect(button(tree, APPLY).props.disabled).toBe(true);

    pending.resolve(response(previewResult()));
    await first;
    tree = panel();
    expect(reviewed(tree)).toBeDefined();
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });

  it.each(['', '2026-02-30', '0000-01-01', '10000-01-01', '2026-10-04T00:00:00Z'])(
    'rejects the non-date-only or out-of-range input %j before any request', async (date) => {
      let tree = panel();
      edit(input(tree), date);
      tree = panel();
      expect(isMoveDate(date)).toBe(false);
      expect(button(tree, REVIEW).props.disabled).toBe(true);
      await click(tree, REVIEW);
      await click(tree, APPLY);
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it('shows each shifted or preserved task with its dates and preservation reason', async () => {
    const tree = await reviewedPanel();
    const rows = nodes(tree).filter((node) => node.type === 'li').map(textOf);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toContain('Pack moving boxes2026-09-13 to 2026-09-27Follows the move date');
    expect(rows[1]).toContain('Meet the movers2026-09-20 to 2026-10-04Follows the move date');
    expect(rows[2]).toContain('Fixed inspection2026-09-14 (unchanged)Fixed date: kept');
    expect(rows[3]).toContain('Completed utility setup2026-09-13 (unchanged)Completed task: kept');
    expect(rows[4]).toContain('Skipped donation pickup2026-09-13 (unchanged)Skipped task: kept');
    expect(rows[5]).toContain('Undated packing reminderNo date (unchanged)No recorded deadline: kept');
    expect(rows[6]).toContain('Manually rescheduled cleaning2026-09-12 (unchanged)Date differs from its recorded offset: kept');
    expect(rows.slice(2).every((row) => !row.includes('2026-09-27'))).toBe(true);
    expect(textOf(reviewed(tree))).toContain('2 deadlines shift; 5 stay unchanged.');
    expect(addMoveDays(move.move_date, -7)).toBe('2026-09-13');
    expect(addMoveDays(NEW_DATE, -7)).toBe('2026-09-27');
    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(body().expected).toBeUndefined();
  });

  it('submits the exact reviewed snapshot and locally generated UUID only on explicit apply, once', async () => {
    const snapshot = preview();
    let tree = await reviewedPanel(snapshot);
    const pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const first = click(tree, APPLY);
    await click(tree, APPLY);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(body()).toEqual({
      familyId: context.familyId, memberId: context.memberId, moveId: move.id, date: NEW_DATE,
      expected: snapshot, requestId: REQUEST_ID,
    });
    tree = panel();
    expect(input(tree).props.disabled).toBe(true);
    expect(button(tree, REVIEW).props.disabled).toBe(true);
    expect(button(tree, APPLY).props.disabled).toBe(true);
    const result = appliedResult(snapshot);
    expect(isMoveDateResult(result)).toBe(true);
    pending.resolve(response(result));
    await first;
    tree = panel();
    expect(mocks.onSaved).toHaveBeenCalledExactlyOnceWith(result);
    expect(reviewed(tree)).toBeUndefined();
    await click(tree, APPLY);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
  });

  it.each(['network', '503'] as const)('preserves the exact review and UUID for an explicit %s retry', async (failure) => {
    const snapshot = preview();
    let tree = await reviewedPanel(snapshot);
    if (failure === 'network') mocks.fetch.mockRejectedValueOnce(new TypeError('Simulated lost response'));
    else mocks.fetch.mockResolvedValueOnce(response({ code: 'unavailable', error: 'Schema unavailable' }, 503));
    await click(tree, APPLY);
    const firstBody = body();
    tree = panel();
    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(reviewed(tree)).toBeDefined();
    expect(button(tree, APPLY).props.disabled).toBe(false);
    expect(textOf(tree)).toMatch(/same request identifier/);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValueOnce(response(appliedResult(snapshot)));
    await click(tree, APPLY);
    expect(body()).toEqual(firstBody);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    expect(mocks.onSaved).toHaveBeenCalledExactlyOnceWith(appliedResult(snapshot));
  });

  it.each(['stale_review', 'idempotency_conflict'])('invalidates a 409 %s and requires a fresh preview and UUID', async (code) => {
    mocks.uuid.mockReturnValueOnce(REQUEST_ID).mockReturnValue(NEXT_REQUEST_ID);
    let tree = await reviewedPanel();
    mocks.fetch.mockResolvedValueOnce(response({ code, error: 'Review no longer matches' }, 409));
    await click(tree, APPLY);
    tree = panel();
    expect(reviewed(tree)).toBeUndefined();
    expect(button(tree, APPLY).props.disabled).toBe(true);
    expect(textOf(tree)).toContain('Review the current deadlines again');
    await click(tree, APPLY);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.onSaved).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(response(previewResult()));
    await click(tree, REVIEW);
    expect(body().expected).toBeUndefined();
    expect(body().requestId).toBeUndefined();
    tree = panel();
    expect(mocks.uuid).toHaveBeenCalledTimes(2);
    mocks.fetch.mockResolvedValueOnce(response(appliedResult(preview(), NEXT_REQUEST_ID)));
    await click(tree, APPLY);
    expect(body().requestId).toBe(NEXT_REQUEST_ID);
    expect(mocks.onSaved).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])('clears an existing review on HTTP %s without a save callback', async (status) => {
    let tree = await reviewedPanel();
    mocks.fetch.mockResolvedValueOnce(response({ code: 'unavailable', error: 'Unavailable' }, status));
    await click(tree, APPLY);
    tree = panel();
    expect(reviewed(tree)).toBeUndefined();
    expect(button(tree, APPLY).props.disabled).toBe(true);
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });

  it('leaves preview unavailable on HTTP 503 without creating a request UUID or apply action', async () => {
    let tree = panel();
    edit(input(tree), NEW_DATE);
    tree = panel();
    mocks.fetch.mockResolvedValueOnce(response({ code: 'unavailable', error: 'Schema not deployed' }, 503));
    await click(tree, REVIEW);
    tree = panel();
    expect(reviewed(tree)).toBeUndefined();
    expect(button(tree, APPLY).props.disabled).toBe(true);
    expect(textOf(tree)).toContain('database capability may not be deployed yet');
    expect(mocks.uuid).not.toHaveBeenCalled();
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });

  const badPreviews: { name: string; valid: boolean; make: (p: MoveDatePreview) => unknown }[] = [
    { name: 'null result', valid: false, make: () => null },
    { name: 'server-assigned preview UUID', valid: false, make: (p) => ({ ...previewResult(p), requestId: OTHER_ID }) },
    { name: 'wrong family', valid: true, make: (p) => previewResult({ ...p, familyId: OTHER_ID }) },
    { name: 'wrong member', valid: true, make: (p) => previewResult({ ...p, memberId: OTHER_ID }) },
    { name: 'wrong move', valid: true, make: (p) => previewResult({ ...p, moveId: OTHER_ID }) },
    { name: 'wrong from date', valid: true, make: (p) => previewResult({ ...p, fromDate: '2026-09-21', tasks: [], changes: 0 }) },
    { name: 'wrong to date', valid: true, make: (p) => previewResult({ ...p, toDate: LATER_DATE, tasks: [], changes: 0 }) },
    { name: 'missing date mode', valid: false, make: (p) => {
      const broken = structuredClone(p);
      Reflect.deleteProperty(broken.tasks[0], 'mode');
      return previewResult(broken);
    } },
    { name: 'fixed task falsely shifted', valid: false, make: (p) => previewResult({
      ...p, tasks: p.tasks.map((item, index) => index === 0 ? { ...item, mode: 'fixed' } : item),
    }) },
    { name: 'completed task falsely shifted', valid: false, make: (p) => previewResult({
      ...p, tasks: p.tasks.map((item, index) => index === 0 ? { ...item, status: 'done' } : item),
    }) },
  ];
  it.each(badPreviews)('cannot apply a preview with $name', async ({ valid, make }) => {
    let tree = panel();
    edit(input(tree), NEW_DATE);
    tree = panel();
    const incoming = make(preview());
    expect(isMoveDateResult(incoming)).toBe(valid);
    mocks.fetch.mockResolvedValueOnce(response(incoming));
    await click(tree, REVIEW);
    tree = panel();
    expect(reviewed(tree)).toBeUndefined();
    expect(button(tree, APPLY).props.disabled).toBe(true);
    await click(tree, APPLY);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.uuid).not.toHaveBeenCalled();
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });

  const badApplies: { name: string; valid: boolean; make: (r: MoveDateResult) => unknown }[] = [
    { name: 'null result', valid: false, make: () => null },
    { name: 'preview-only response', valid: true, make: (r) => previewResult(r.preview) },
    { name: 'missing applied timestamp', valid: false, make: (r) => ({ ...r, appliedAt: null }) },
    { name: 'wrong request UUID', valid: true, make: (r) => ({ ...r, requestId: OTHER_ID }) },
    { name: 'wrong family', valid: true, make: (r) => ({ ...r, preview: { ...r.preview, familyId: OTHER_ID } }) },
    { name: 'wrong member', valid: true, make: (r) => ({ ...r, preview: { ...r.preview, memberId: OTHER_ID } }) },
    { name: 'wrong move', valid: true, make: (r) => ({ ...r, preview: { ...r.preview, moveId: OTHER_ID } }) },
    { name: 'wrong from date', valid: true, make: (r) => ({ ...r, preview: { ...r.preview, fromDate: '2026-09-21', tasks: [], changes: 0 } }) },
    { name: 'wrong to date', valid: true, make: (r) => ({ ...r, preview: { ...r.preview, toDate: LATER_DATE, tasks: [], changes: 0 } }) },
    { name: 'different move version', valid: true, make: (r) => ({
      ...r, preview: { ...r.preview, moveUpdatedAt: '2026-09-06T12:01:00.000Z' },
    }) },
    { name: 'different task title', valid: true, make: (r) => ({
      ...r, preview: {
        ...r.preview, tasks: r.preview.tasks.map((item, index) => index === 0 ? { ...item, title: 'Changed after review' } : item),
      },
    }) },
    { name: 'different task version', valid: true, make: (r) => ({
      ...r, preview: {
        ...r.preview, tasks: r.preview.tasks.map((item, index) =>
          index === 0 ? { ...item, updatedAt: '2026-09-06T12:02:00.000Z' } : item),
      },
    }) },
  ];
  it.each(badApplies)('never calls onSaved for an apply response with $name', async ({ valid, make }) => {
    let tree = await reviewedPanel();
    const sent = preview();
    const incoming = make(appliedResult(sent));
    expect(isMoveDateResult(incoming)).toBe(valid);
    mocks.fetch.mockResolvedValueOnce(response(incoming));
    await click(tree, APPLY);
    tree = panel();
    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(nodes(tree).some((node) => node.props.role === 'alert')).toBe(true);
    expect(body().expected).toEqual(sent);
    expect(body().requestId).toBe(REQUEST_ID);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'child', patch: { role: 'child' } },
    { name: 'unknown role', patch: { role: 'admin' } },
    { name: 'missing role', patch: { role: null } },
    { name: 'inactive parent', patch: { active: false } },
    { name: 'inactive adult', patch: { role: 'adult', active: false } },
    { name: 'missing membership', patch: { memberId: null } },
  ])('denies all actions for $name, including direct handler replay', async ({ patch }) => {
    const denied: MoveDateReviewContext = { ...context, ...patch };
    let tree = panel(denied);
    expect(input(tree).props.disabled).toBe(true);
    edit(input(tree), NEW_DATE);
    tree = panel(denied);
    expect(button(tree, REVIEW).props.disabled).toBe(true);
    expect(button(tree, APPLY).props.disabled).toBe(true);
    await click(tree, REVIEW);
    await click(tree, APPLY);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.uuid).not.toHaveBeenCalled();
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });

  it('allows an active adult member to review and explicitly apply', async () => {
    const tree = await reviewedPanel(preview(), { ...context, role: 'adult' });
    mocks.fetch.mockResolvedValueOnce(response(appliedResult()));
    await click(tree, APPLY);
    expect(mocks.onSaved).toHaveBeenCalledTimes(1);
  });

  it.each(['done', 'cancelled'])('refuses a %s move even for an active parent', async (status) => {
    const target = { ...move, status };
    let tree = panel(context, target);
    edit(input(tree), NEW_DATE);
    tree = panel(context, target);
    expect(input(tree).props.disabled).toBe(true);
    expect(button(tree, REVIEW).props.disabled).toBe(true);
    await click(tree, REVIEW);
    await click(tree, APPLY);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  const contexts: { name: string; patch: Partial<MoveDateReviewContext> }[] = [
    { name: 'family', patch: { familyId: OTHER_ID } },
    { name: 'user', patch: { userId: OTHER_ID } },
    { name: 'member', patch: { memberId: OTHER_ID } },
    { name: 'role', patch: { role: 'adult' } },
    { name: 'activity', patch: { active: false } },
  ];
  it.each(contexts)('invalidates the previous context handler when $name changes on the same mount', async ({ patch }) => {
    const oldTree = await reviewedPanel();
    const ctx = { ...context, ...patch };
    const tree = panel(ctx);
    expect(moveDateContextKey(ctx)).not.toBe(moveDateContextKey(context));
    expect(reviewed(tree)).toBeUndefined();
    expect(input(tree).props.value).toBe(move.move_date);
    await click(oldTree, APPLY);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });

  const invalidations = [
    'date', 'context', 'context-key remount', 'move ID', 'move date',
    'move updated_at', 'move status', 'unmount', 'cancel',
  ] as const;
  const pendingCases = (['preview', 'apply'] as const).flatMap((phase) =>
    invalidations.map((invalidation) => ({ phase, invalidation })));
  it.each(pendingCases)('ignores a deferred $phase response after $invalidation', async ({ phase, invalidation }) => {
    let ctx = context;
    let target = move;
    let key = invalidation === 'context-key remount' ? moveDateContextKey(ctx) + ':' + target.id : 'panel';
    let tree = panel(ctx, target, key);
    edit(input(tree), NEW_DATE);
    tree = panel(ctx, target, key);
    if (phase === 'apply') tree = await reviewedPanel(preview(), ctx, target, key);
    const beforePendingInput = input(tree);
    const pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const request = click(tree, phase === 'apply' ? APPLY : REVIEW);
    const signal = options().signal as AbortSignal;
    tree = panel(ctx, target, key);
    expect(input(tree).props.disabled).toBe(true);
    expect(button(tree, REVIEW).props.disabled).toBe(true);
    expect(button(tree, APPLY).props.disabled).toBe(true);
    let gone = false;
    if (invalidation === 'date') {
      // The pending input is disabled. Replay a previously captured change handler
      // to probe invalidation; this is not a claim about browser typing while disabled.
      edit(beforePendingInput, LATER_DATE);
    } else if (invalidation === 'context' || invalidation === 'context-key remount') {
      ctx = { ...context, familyId: OTHER_ID };
      if (invalidation === 'context-key remount') key = moveDateContextKey(ctx) + ':' + target.id;
    } else if (invalidation === 'move ID') target = { ...move, id: OTHER_ID };
    else if (invalidation === 'move date') target = { ...move, move_date: '2026-09-21' };
    else if (invalidation === 'move updated_at') target = { ...move, updated_at: '2026-09-06T12:01:00.000Z' };
    else if (invalidation === 'move status') target = { ...move, status: 'cancelled' };
    else if (invalidation === 'cancel') {
      mocks.onClose.mockImplementation(unmount);
      await click(tree, 'Cancel');
      expect(mocks.onClose).toHaveBeenCalledTimes(1);
      gone = true;
    } else {
      unmount();
      gone = true;
    }
    if (!gone) tree = panel(ctx, target, key);
    expect(signal.aborted).toBe(true);
    pending.resolve(response(phase === 'apply' ? appliedResult() : previewResult()));
    await request;
    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(mocks.uuid).toHaveBeenCalledTimes(phase === 'apply' ? 1 : 0);
    expect(mocks.fetch).toHaveBeenCalledTimes(phase === 'apply' ? 2 : 1);
    if (!gone) {
      tree = panel(ctx, target, key);
      expect(reviewed(tree)).toBeUndefined();
      expect(button(tree, APPLY).props.disabled).toBe(true);
      expect(nodes(tree).filter((node) => node.props.role === 'alert')).toHaveLength(
        invalidation === 'move status' ? 1 : 0,
      );
    }
  });

  it('keeps a newer review intact when an aborted older preview resolves last', async () => {
    let tree = panel();
    edit(input(tree), NEW_DATE);
    tree = panel();
    const oldInput = input(tree);
    const pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const oldRequest = click(tree, REVIEW);
    const oldSignal = options().signal as AbortSignal;
    edit(oldInput, LATER_DATE);
    tree = panel();
    const current = preview({ toDate: LATER_DATE, tasks: [], changes: 0 });
    expect(isMoveDatePreview(current)).toBe(true);
    mocks.fetch.mockResolvedValueOnce(response(previewResult(current)));
    await click(tree, REVIEW);
    expect(oldSignal.aborted).toBe(true);
    pending.resolve(response(previewResult()));
    await oldRequest;
    tree = panel();
    expect(input(tree).props.value).toBe(LATER_DATE);
    expect(textOf(reviewed(tree))).toContain(LATER_DATE);
    expect(textOf(reviewed(tree))).toContain('No recorded tasks. Only the move date will change.');
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    expect(mocks.onSaved).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(response(appliedResult(current)));
    await click(tree, APPLY);
    expect(body().expected).toEqual(current);
    expect(body().requestId).toBe(REQUEST_ID);
    expect(mocks.onSaved).toHaveBeenCalledExactlyOnceWith(appliedResult(current));
  });

  it('cancels an untouched panel without fetching or saving', async () => {
    await click(panel(), 'Cancel');
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });
});

