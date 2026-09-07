import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationImportWorkspace, TripConfirmationImport } from '@/components/vacations/trip-confirmation-import';
import type { ConfirmationImportContext, ConfirmationPreview } from '@/lib/vacations/confirmation-import';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
const mocks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: new Set<() => void>(), key: null as string | null,
  fetch: vi.fn(),
  context: {
    familyId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    selfMember: { id: '00000000-0000-4000-8000-000000000003', role: 'parent', is_active: true } as { id: string; role: string; is_active: boolean } | null,
  },
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++, slots = mocks.slots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = mocks.cursor++, slots = mocks.slots;
    const previous = slots[index] as Effect | undefined;
    if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    mocks.effects.push(() => {
      if (previous?.cleanup) { previous.cleanup(); mocks.cleanups.delete(previous.cleanup); }
      const cleanup = effect();
      slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      if (typeof cleanup === 'function') mocks.cleanups.add(cleanup);
    });
  },
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  // These tests call components as plain functions with hand-mocked hooks, so
  // useContext is unavailable. Resolve through the real catalogue rather than
  // returning the key, so assertions keep checking the words a user sees.
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  return {
    useTranslations: () => (key: string) => SOURCE_MESSAGES[key] ?? key,
    useLocale: () => ({ code: 'en-US', language: 'en', region: 'US', dir: 'ltr' }),
    useLocaleSource: () => 'default',
  };
});
vi.mock('@/components/app/app-context', () => ({ useApp: () => mocks.context }));

const id = (suffix: string) => '00000000-0000-4000-8000-' + suffix.padStart(12, '0');
const TRIP = id('4'), REQUEST = id('5');
const SOURCE = [
  'Name: Fixture dinner', 'Kind: dining', 'Location: Fixture pier',
  'Reserved at: 2026-09-20T18:30:00-04:00', 'Party size: 4', 'Confirmation code: TEST-42',
].join('\r\n');
const preview = (): ConfirmationPreview => ({
  version: 1, familyId: id('1'), vacationId: TRIP, memberId: id('3'),
  trip: { id: TRIP, title: 'Fixture trip', startDate: '2026-09-20', endDate: '2026-09-21', timezone: 'America/New_York', status: 'planning', updatedAt: '2026-09-06T07:00:00Z' },
  source: { title: 'Travel confirmation', text: SOURCE, sha256: 'a'.repeat(64) },
  fields: { name: 'Fixture dinner', kind: 'dining', location: 'Fixture pier', reservedAt: '2026-09-20T18:30:00-04:00', partySize: 4, confirmationCode: 'TEST-42', booked: false },
  itinerary: { date: '2026-09-20', startTime: '18:30:00', dayPart: 'evening' },
});
const previewResult = () => ({ preview: preview(), applied: false, requestId: null, appliedAt: null, reservationId: null, itineraryItemId: null });
const receipt = () => ({ preview: preview(), applied: true, requestId: REQUEST, appliedAt: '2026-09-06T07:30:00Z', reservationId: id('6'), itineraryItemId: id('7') });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
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
function unmount() {
  mocks.cleanups.forEach((cleanup) => cleanup());
  mocks.cleanups.clear(); mocks.effects = []; mocks.slots = []; mocks.key = null;
}
function render(vacationId = TRIP): ReturnType<typeof ConfirmationImportWorkspace> {
  const wrapper = TripConfirmationImport({ vacationId });
  if (!wrapper) { unmount(); return null; }
  expect(wrapper.type).toBe(ConfirmationImportWorkspace);
  if (mocks.key !== wrapper.key) { unmount(); mocks.key = wrapper.key; }
  mocks.cursor = 0;
  const result = ConfirmationImportWorkspace(wrapper.props as { context: ConfirmationImportContext });
  mocks.effects.splice(0).forEach((effect) => effect());
  return result;
}
function change(root: ReactNode, name: string, value: string | boolean) {
  const node = nodes(root).find((entry) => entry.props.name === name);
  if (!node) throw new Error('Missing input ' + name);
  (node.props.onChange as (event: unknown) => void)({ target: { value, checked: value === true } });
}
function button(root: ReactNode, label: string): Node {
  const node = nodes(root).find((entry) => typeof entry.props.onClick === 'function' && textOf(entry.props.children as ReactNode) === label);
  if (!node) throw new Error('Missing button ' + label);
  return node;
}
async function click(root: ReactNode, label: string) {
  await (button(root, label).props.onClick as () => unknown)();
}
async function submit(root: ReactNode) {
  const form = nodes(root).find((entry) => entry.type === 'form');
  if (!form) throw new Error('Missing form');
  await (form.props.onSubmit as (event: unknown) => unknown)({ preventDefault: vi.fn() });
}
async function filled(): Promise<ReactNode> {
  let root = render(); change(root, 'sourceText', SOURCE); root = render();
  await click(root, 'Suggest fields from this text');
  return render();
}
async function reviewed(): Promise<ReactNode> {
  const root = await filled();
  mocks.fetch.mockResolvedValueOnce(response(previewResult()));
  await submit(root);
  return render();
}
function requestBody(index: number) {
  return JSON.parse((mocks.fetch.mock.calls[index][1] as RequestInit).body as string);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  unmount(); mocks.fetch.mockReset();
  mocks.context.familyId = id('1'); mocks.context.userId = id('2');
  mocks.context.selfMember = { id: id('3'), role: 'parent', is_active: true };
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('crypto', { randomUUID: () => REQUEST });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('travel confirmation review UI', () => {
  it('does not load or mutate anything on mount or while suggesting fields', async () => {
    const root = await filled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(nodes(root).find((node) => node.props.name === 'booked')?.props.checked).toBe(false);
    expect(textOf(root)).toContain('No links are opened');
  });
  it('keeps preview read-only and requires an explicit acknowledgement before save', async () => {
    let root = await reviewed();
    expect(requestBody(0)).toEqual({
      action: 'preview', familyId: id('1'), memberId: id('3'), vacationId: TRIP,
      source: { title: 'Travel confirmation', text: SOURCE }, fields: preview().fields,
    });
    expect(button(root, 'Save reservation and itinerary entry').props.disabled).toBe(true);
    await click(root, 'Save reservation and itinerary entry');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    change(root, 'acknowledged', true); root = render();
    mocks.fetch.mockResolvedValueOnce(response(receipt()));
    await click(root, 'Save reservation and itinerary entry');
    expect(requestBody(1)).toMatchObject({ action: 'apply', expected: preview(), requestId: REQUEST });
    root = render();
    expect(textOf(root)).toContain('Reservation and itinerary entry saved');
    expect(textOf(root)).toContain('No provider booking, payment, or calendar event was made.');
    expect(textOf(root)).toContain(SOURCE);
  });
  it('retains the original source when a material field is corrected before review', async () => {
    let root = await filled(); change(root, 'name', 'Corrected dinner'); root = render();
    const result = previewResult(); result.preview.fields.name = 'Corrected dinner';
    mocks.fetch.mockResolvedValueOnce(response(result));
    await submit(root);
    expect(requestBody(0).source.text).toBe(SOURCE);
    expect(requestBody(0).fields.name).toBe('Corrected dinner');
    expect(textOf(render())).toContain('Review before saving');
  });
  it('invalidates the complete review when a material field changes', async () => {
    const root = await reviewed(); change(root, 'confirmationCode', 'CORRECTED');
    expect(textOf(render())).not.toContain('Review before saving');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('clears extracted fields when the source changes', async () => {
    const root = await filled(); change(root, 'sourceText', 'Name: Another source');
    const next = render();
    expect(nodes(next).find((node) => node.props.name === 'name')?.props.value).toBe('');
    expect(nodes(next).find((node) => node.props.name === 'reservedAt')?.props.value).toBe('');
  });
  it('preserves the same request and approved payload after an uncertain save response', async () => {
    let root = await reviewed(); change(root, 'acknowledged', true); root = render();
    mocks.fetch.mockRejectedValueOnce(new Error('network'));
    await click(root, 'Save reservation and itinerary entry');
    root = render();
    expect(textOf(root)).not.toContain('Reservation and itinerary entry saved');
    const firstApply = requestBody(1);
    mocks.fetch.mockResolvedValueOnce(response(receipt()));
    await click(root, 'Retry saving this review');
    expect(requestBody(2)).toEqual(firstApply);
    expect(textOf(render())).toContain('Reservation and itinerary entry saved');
  });
  it.each([400, 401, 403, 404, 409])('drops stale or denied reviews after apply status %s', async (status) => {
    let root = await reviewed(); change(root, 'acknowledged', true); root = render();
    mocks.fetch.mockResolvedValueOnce(response({ error: 'sensitive server detail' }, status));
    await click(root, 'Save reservation and itinerary entry');
    expect(textOf(render())).not.toContain('Review before saving');
    expect(textOf(render())).not.toContain('sensitive server detail');
    expect(textOf(render())).not.toContain('Reservation and itinerary entry saved');
  });
  it('keeps a 503 save retry bound to the same receipt request', async () => {
    let root = await reviewed(); change(root, 'acknowledged', true); root = render();
    mocks.fetch.mockResolvedValueOnce(response({}, 503));
    await click(root, 'Save reservation and itinerary entry');
    root = render(); expect(textOf(root)).toContain('Retry saving this review');
    mocks.fetch.mockResolvedValueOnce(response(receipt()));
    await click(root, 'Retry saving this review');
    expect(requestBody(2)).toEqual(requestBody(1));
  });
  it('refuses malformed or foreign preview output rather than displaying its source', async () => {
    const root = await filled(), result = previewResult();
    result.preview.familyId = id('99'); result.preview.source.text = 'FOREIGN SOURCE';
    mocks.fetch.mockResolvedValueOnce(response(result));
    await submit(root);
    expect(textOf(render())).not.toContain('FOREIGN SOURCE');
    expect(textOf(render())).not.toContain('Review before saving');
    expect(textOf(render())).toContain('trustworthy preview');
  });
  it('does not report an unrelated receipt as success', async () => {
    let root = await reviewed(); change(root, 'acknowledged', true); root = render();
    mocks.fetch.mockResolvedValueOnce(response({ ...receipt(), requestId: id('99') }));
    await click(root, 'Save reservation and itinerary entry');
    expect(textOf(render())).not.toContain('Reservation and itinerary entry saved');
    expect(textOf(render())).toContain('Retry saving this review');
  });
  it('uses a synchronous busy guard against duplicate preview submissions', async () => {
    const root = await filled(), pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const first = submit(root), second = submit(root);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response(previewResult()));
    await Promise.all([first, second]);
    expect(textOf(render())).toContain('Review before saving');
  });
  it.each(['family', 'account', 'member', 'trip', 'role', 'inactive'] as const)('aborts and discards a pending response across %s changes', async (boundary) => {
    const root = await filled(), pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const waiting = submit(root);
    const signal = (mocks.fetch.mock.calls[0][1] as RequestInit).signal;
    if (boundary === 'family') mocks.context.familyId = id('90');
    if (boundary === 'account') mocks.context.userId = id('90');
    if (boundary === 'member') mocks.context.selfMember!.id = id('90');
    if (boundary === 'role') mocks.context.selfMember!.role = 'child';
    if (boundary === 'inactive') mocks.context.selfMember!.is_active = false;
    const nextTrip = boundary === 'trip' ? id('90') : TRIP;
    render(nextTrip);
    expect(signal?.aborted).toBe(true);
    pending.resolve(response(previewResult()));
    await waiting;
    const next = render(nextTrip);
    expect(textOf(next)).not.toContain(SOURCE);
    expect(textOf(next)).not.toContain('Review before saving');
  });
  it.each(['child', 'teen', 'guest', 'system'])('does not offer import to role %s', (role) => {
    mocks.context.selfMember!.role = role;
    expect(render()).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('renders source and evidence as text, never executable markup', async () => {
    let root = render(); change(root, 'sourceText', 'Name: <script>fixture()</script>'); root = render();
    await click(root, 'Suggest fields from this text'); root = render();
    expect(nodes(root).every((node) => !('dangerouslySetInnerHTML' in node.props))).toBe(true);
    expect(nodes(root).find((node) => node.props.name === 'name')?.props.value).toBe('<script>fixture()</script>');
  });
});
