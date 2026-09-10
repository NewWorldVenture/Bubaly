import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedCalendar } from '@/components/onboarding/connected-calendar';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { buildFirstBrief } from '@/lib/onboarding/first-brief';

// Real component controls and async handlers; simulated hooks/storage, no DOM.
type Effect = { deps: unknown[]; cleanup?: () => void };
const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  start: vi.fn(), preview: vi.fn(), assign: vi.fn(), receive: vi.fn() }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = mocks.cursor++; const previous = mocks.slots[index] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) mocks.slots[index] = { value: factory(), deps };
    return (mocks.slots[index] as { value: unknown }).value;
  },
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [mocks.slots[index], (value: unknown) => { mocks.slots[index] = typeof value === 'function' ? value(mocks.slots[index]) : value; }];
  },
  useRef: (initial: unknown) => { const index = mocks.cursor++; if (!(index in mocks.slots)) mocks.slots[index] = { current: initial }; return mocks.slots[index]; },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = mocks.cursor++;
    const previous = mocks.slots[index] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) mocks.slots[index] = { value: callback, deps };
    return (mocks.slots[index] as { value: unknown }).value;
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = mocks.cursor++;
    const previous = mocks.slots[index] as Effect | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) mocks.effects.push(() => {
      previous?.cleanup?.(); mocks.slots[index] = { deps, cleanup: effect() };
    });
  },
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const t = (key: string, vars?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, vars);
  return { useTranslations: () => t };
});
vi.mock('@/app/onboarding/calendar-actions', () => ({ startCalendarConnectionAction: mocks.start, previewConnectedCalendarAction: mocks.preview }));
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const defaults = { providers: ['google', 'microsoft'] as ('google' | 'microsoft')[], family: { name: 'Ada family', timezone: 'UTC' }, displayName: 'Ada', onPreview: mocks.receive };
function render(extra: Partial<Parameters<typeof ConnectedCalendar>[0]> = {}) {
  mocks.cursor = 0;
  const tree = ConnectedCalendar({ ...defaults, ...extra });
  mocks.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function button(tree: ReactNode, key: string) {
  const label = translate(SOURCE_MESSAGES, key);
  const node = nodes(tree).find((candidate) => typeof candidate.props.onClick === 'function' && textOf(candidate) === label);
  if (!node) throw new Error(`Missing control: ${label}`);
  return node;
}
beforeEach(() => {
  mocks.slots = []; mocks.cursor = 0; mocks.effects = [];
  mocks.start.mockReset().mockResolvedValue({ ok: true, url: '/api/sync/google/auth?onboarding=1' });
  mocks.preview.mockReset(); mocks.receive.mockReset(); mocks.assign.mockReset();
  vi.stubGlobal('window', { location: { assign: mocks.assign } });
});
afterEach(() => vi.unstubAllGlobals());

describe('reachable primary-calendar onboarding controls', () => {
  it('shows configured providers and starts consent only after the corresponding explicit click', async () => {
    const tree = render({ providers: ['google'] });
    expect(textOf(tree)).toContain('primary calendar');
    expect(textOf(tree)).toContain('connection stays paused');
    expect(textOf(tree)).not.toContain('Connect Microsoft Calendar');
    expect(mocks.start).not.toHaveBeenCalled();
    (button(tree, 'connectedCalendar.google').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('/api/sync/google/auth?onboarding=1'));
    expect(mocks.start).toHaveBeenCalledWith({ provider: 'google', family: defaults.family, displayName: 'Ada' });
  });
  it('hides unavailable providers and recovers a rejected start without claiming a connection', async () => {
    expect(render({ providers: [] })).toBeNull();
    mocks.start.mockRejectedValueOnce(new Error('transport failed'));
    (button(render(), 'connectedCalendar.microsoft').props.onClick as () => void)();
    await vi.waitFor(() => expect(textOf(render())).toContain(SOURCE_MESSAGES['connectedCalendar.unavailable']));
    expect(button(render(), 'connectedCalendar.microsoft').props.disabled).toBe(false);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.receive).not.toHaveBeenCalled();
  });
  it('shows failed preview recovery and passes only the successful owned preview to the wizard', async () => {
    mocks.preview.mockResolvedValueOnce({ ok: false, error: 'Read temporarily unavailable' });
    render({ accountId: 'owned-account' });
    await vi.waitFor(() => expect(textOf(render({ accountId: 'owned-account' }))).toContain('Read temporarily unavailable'));
    const data = { events: [], receipt: 'sealed-proof', calendarName: 'Primary', brief: buildFirstBrief([], new Date()) };
    mocks.preview.mockResolvedValueOnce({ ok: true, data });
    (button(render({ accountId: 'owned-account' }), 'connectedCalendar.retry').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.receive).toHaveBeenCalledWith(data));
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('ignores a slow preview for a previous account after the current account changes', async () => {
    let finishFirst: (value: unknown) => void = () => {};
    mocks.preview.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const current = { events: [], receipt: 'current-proof', calendarName: 'Current', brief: buildFirstBrief([], new Date()) };
    mocks.preview.mockResolvedValueOnce({ ok: true, data: current });
    render({ accountId: 'first' }); render({ accountId: 'second' });
    await vi.waitFor(() => expect(mocks.receive).toHaveBeenCalledWith(current));
    finishFirst({ ok: true, data: { ...current, receipt: 'old-proof', calendarName: 'Old' } });
    await Promise.resolve(); await Promise.resolve();
    expect(mocks.receive).toHaveBeenCalledTimes(1);
  });
});

describe('pricing hint on explicit calendar connection', () => {
  const expectedOwner = { userId: '11111111-1111-4111-8111-111111111111', familyId: null };
  it('passes only the typed choice and owner assertion outside the business input', async () => {
    const tree = render({ reviewPlan: 'plus_annual', expectedOwner });
    expect(mocks.start).not.toHaveBeenCalled();
    (button(tree, 'connectedCalendar.google').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ provider: 'google', family: defaults.family, displayName: 'Ada' }, { expectedOwner, reviewPlan: 'plus_annual' }));
  });
  it('an old owner callback cannot start connection after a new owner is rendered', () => {
    const previous = button(render({ expectedOwner, reviewPlan: 'basic_annual' }), 'connectedCalendar.google').props.onClick as () => void;
    render({ expectedOwner: { ...expectedOwner, userId: '22222222-2222-4222-8222-222222222222' }, reviewPlan: 'basic_annual' });
    previous(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.assign).not.toHaveBeenCalled();
  });
  it('a slow successful old-owner start cannot navigate the new account to its consent URL', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    (button(render({ expectedOwner, reviewPlan: 'plus_annual' }), 'connectedCalendar.google').props.onClick as () => void)();
    render({ expectedOwner: { ...expectedOwner, userId: '22222222-2222-4222-8222-222222222222' }, reviewPlan: 'plus_annual' });
    resolve({ ok: true, url: '/api/sync/google/auth?onboarding=1' });
    await Promise.resolve(); await Promise.resolve(); expect(mocks.assign).not.toHaveBeenCalled();
  });
});

describe('calendar screen callbacks cannot revive across ABA changes',()=>{
 const expectedOwner={userId:'11111111-1111-4111-8111-111111111111',familyId:null};
 const otherOwner={...expectedOwner,userId:'22222222-2222-4222-8222-222222222222'};
 it('retained Connect remains invalid after the owner changes away and back',()=>{
  const old=button(render({expectedOwner,reviewPlan:'plus_annual'}),'connectedCalendar.google').props.onClick as ()=>void;
  render({expectedOwner:otherOwner,reviewPlan:'plus_annual'});render({expectedOwner,reviewPlan:'plus_annual'});old();
  expect(mocks.start).not.toHaveBeenCalled();expect(mocks.assign).not.toHaveBeenCalled();
 });
 it('retained Retry cannot issue a preview before passive cleanup after the owner changes',async()=>{
  mocks.preview.mockResolvedValueOnce({ok:false,error:'Retry the preview'});
  render({expectedOwner,accountId:'same-account'});await vi.waitFor(()=>expect(textOf(render({expectedOwner,accountId:'same-account'}))).toContain('Retry the preview'));
  const retry=button(render({expectedOwner,accountId:'same-account'}),'connectedCalendar.retry').props.onClick as ()=>void;
  mocks.cursor=0;ConnectedCalendar({...defaults,expectedOwner:otherOwner,accountId:'same-account'});
  const count=mocks.preview.mock.calls.length;retry();expect(mocks.preview).toHaveBeenCalledTimes(count);
 });
 it('late rejected preview cannot show its failure on a newly rendered owner before cleanup',async()=>{
  let reject:(error:unknown)=>void=()=>{};mocks.preview.mockImplementationOnce(()=>new Promise((_,no)=>{reject=no;}));
  render({expectedOwner,accountId:'same-account'});
  mocks.cursor=0;ConnectedCalendar({...defaults,expectedOwner:otherOwner,accountId:'same-account'});
  reject(new Error('private old error'));await Promise.resolve();await Promise.resolve();
  mocks.cursor=0;const current=ConnectedCalendar({...defaults,expectedOwner:otherOwner,accountId:'same-account'});
  expect(textOf(current)).not.toContain(SOURCE_MESSAGES['connectedCalendar.unavailable']);
 });
});
