import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { buildFinalizePayload, DRAFT_STORAGE_KEY, emptyDraft, serializeDraftState } from '@/lib/onboarding/flow';
import { onboardingRunKey } from '@/lib/onboarding/idempotency';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

type Effect = { deps: unknown[]; cleanup?: () => void };
const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  finish: vi.fn(), push: vi.fn(), refresh: vi.fn(), error: vi.fn(), locale: 'en-US' as LocaleCode }));
// Actual wizard callbacks with persistent hook slots and storage; no browser claim.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = mocks.cursor++; const previous = mocks.slots[index] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) mocks.slots[index] = { value: factory(), deps };
    return (mocks.slots[index] as { value: unknown }).value;
  },
  useState: (initial: unknown) => { const i = mocks.cursor++; if (!(i in mocks.slots)) mocks.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [mocks.slots[i], (value: unknown) => { mocks.slots[i] = typeof value === 'function' ? value(mocks.slots[i]) : value; }]; },
  useRef: (initial: unknown) => { const i = mocks.cursor++; if (!(i in mocks.slots)) mocks.slots[i] = { current: initial }; return mocks.slots[i]; },
  useCallback: (value: unknown) => { mocks.cursor++; return value; },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const i = mocks.cursor++; const previous = mocks.slots[i] as Effect | undefined;
    if (!previous || deps.some((v, k) => !Object.is(v, previous.deps[k]))) mocks.effects.push(() => { previous?.cleanup?.(); mocks.slots[i] = { deps, cleanup: effect() }; });
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: mocks.error }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
 const { getMessages, translate } = await import('@/lib/i18n/messages');
 return { useTranslations: () => (key: string, vars?: Record<string, string | number>) => translate(getMessages(mocks.locale), key, vars) };
});
vi.mock('@/app/onboarding/actions', () => ({ finalizeOnboardingAction: mocks.finish, previewCalendarImportAction: vi.fn() }));
vi.mock('@/app/onboarding/calendar-actions', () => ({ startCalendarConnectionAction: vi.fn(), previewConnectedCalendarAction: vi.fn() }));
vi.mock('@/lib/analytics/onboarding-track', () => ({ trackOnboarding: vi.fn() }));
vi.mock('@/components/outcomes/do-one-thing-card', () => ({ DoOneThingCard: () => null }));
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : []; }
function textOf(node: ReactNode): string { return Array.isArray(node) ? node.map(textOf).join('') : isValidElement<{children?: ReactNode}>(node) ? textOf(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
const userId = '11111111-1111-4111-8111-111111111111';
const familyId = '22222222-2222-4222-8222-222222222222';
const owner = { userId, familyId: null };
const draft = emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: 'UTC' });
let storage = new Map<string, string>();
function render(extra: Partial<Parameters<typeof OnboardingWizard>[0]> = {}) {
 mocks.cursor = 0; const tree = OnboardingWizard({ expectedOwner: owner, reviewPlan: 'plus_annual', ...extra });
 mocks.effects.splice(0).forEach(effect => effect()); return tree;
}
function finishControl(tree: ReactNode) { const result = nodes(tree).find(node=>typeof node.props.onClick === 'function' && textOf(node).includes('Finish setup')); if(!result) throw new Error('Missing Finish setup control'); return result.props.onClick as () => void; }
function donePanel(tree: ReactNode) { const node=nodes(tree).find(n=>typeof n.type === 'function' && n.type.name === 'DonePanel'); return node ? (node.type as (props: unknown)=>ReactNode)(node.props) : null; }
function control(tree: ReactNode, key: string) { const label=translate(getMessages(mocks.locale),key);const node=nodes(tree).find(n=>typeof n.props.onClick==='function' && textOf(n).trim()===label);if(!node)throw new Error(`Missing ${key}`);return node.props.onClick as ()=>void; }
beforeEach(()=>{
 mocks.slots=[];mocks.cursor=0;mocks.effects=[];mocks.locale='en-US';
 mocks.finish.mockReset().mockResolvedValue({ok:true,data:{familyId}});mocks.push.mockReset();mocks.refresh.mockReset();mocks.error.mockReset();
 storage=new Map([[DRAFT_STORAGE_KEY,serializeDraftState('pin',draft,true)]]);
 vi.stubGlobal('sessionStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 vi.stubGlobal('window',{});
});
afterEach(()=>vi.unstubAllGlobals());

describe('explicit selected-plan review after successful onboarding',()=>{
 it.each(['basic_monthly','basic_annual','plus_monthly','plus_annual'] as const)('keeps %s separate from restored draft, business payload and run keys',async(reviewPlan)=>{
  render({reviewPlan});const tree=render({reviewPlan});
  expect(storage.get(DRAFT_STORAGE_KEY)).not.toContain('reviewPlan');
  expect(mocks.finish).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled();
  finishControl(tree)();await vi.waitFor(()=>expect(donePanel(render({reviewPlan}))).not.toBeNull());
  const [payload,expectedOwner]=mocks.finish.mock.calls[0];
  expect(payload).toEqual(buildFinalizePayload({ ...draft, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));expect(expectedOwner).toEqual(owner);
  expect(onboardingRunKey(userId,payload)).toBe(onboardingRunKey(userId,buildFinalizePayload({ ...draft, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
  expect(storage.has(DRAFT_STORAGE_KEY)).toBe(false);expect(mocks.push).not.toHaveBeenCalled();
  control(donePanel(render({reviewPlan})),'onboardingWizard.reviewSelectedPlan')();
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/dashboard/billing?view=manage&reviewPlan=${reviewPlan}`);
 });
 it('a failed Finish retains choice and draft for retry and cannot expose review',async()=>{
  mocks.finish.mockResolvedValueOnce({ok:false,error:'Save unavailable'});
  render();finishControl(render())();await vi.waitFor(()=>expect(mocks.error).toHaveBeenCalled());
  expect(donePanel(render())).toBeNull();expect(storage.has(DRAFT_STORAGE_KEY)).toBe(true);expect(mocks.push).not.toHaveBeenCalled();
  finishControl(render())();await vi.waitFor(()=>expect(donePanel(render())).not.toBeNull());
  control(donePanel(render()),'onboardingWizard.reviewSelectedPlan')();expect(mocks.push).toHaveBeenCalledWith('/dashboard/billing?view=manage&reviewPlan=plus_annual');
 });
 it('double Finish callbacks submit once while the same request is pending',async()=>{
  let resolve:(value:unknown)=>void=()=>{};mocks.finish.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  render();const finish=finishControl(render());finish();finish();expect(mocks.finish).toHaveBeenCalledTimes(1);
  resolve({ok:true,data:{familyId}});await vi.waitFor(()=>expect(donePanel(render())).not.toBeNull());
 });
 it('retained old-owner callback cannot submit after a current owner render',()=>{
  render();const old=finishControl(render());render({expectedOwner:{userId:'33333333-3333-4333-8333-333333333333',familyId:null}});old();
  expect(mocks.finish).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled();
 });
 it('an old successful response cannot navigate or show Done after owner changes',async()=>{
  let resolve:(value:unknown)=>void=()=>{};mocks.finish.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  render();finishControl(render())();const current={expectedOwner:{userId:'33333333-3333-4333-8333-333333333333',familyId:null}};render(current);
  resolve({ok:true,data:{familyId}});await Promise.resolve();await Promise.resolve();
  expect(donePanel(render(current))).toBeNull();expect(mocks.push).not.toHaveBeenCalled();expect(storage.has(DRAFT_STORAGE_KEY)).toBe(true);
 });
 it.each(['en-US','de-DE','es-ES','fr-FR','it-IT','nl-NL','pt-PT'] as const)('%s retains Start exploring and translates the explicit review action',async(locale)=>{
  mocks.locale=locale;render();finishControl(render())();await vi.waitFor(()=>expect(donePanel(render())).not.toBeNull());
  const panel=donePanel(render());expect(textOf(panel)).toContain(translate(getMessages(locale),'onboardingWizard.reviewSelectedPlan'));
  control(panel,'onboardingWizard.startExploring')();expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard');
 });
 it('plain onboarding has no review action and keeps its dashboard control',async()=>{
  render({reviewPlan:null});finishControl(render({reviewPlan:null}))();await vi.waitFor(()=>expect(donePanel(render({reviewPlan:null}))).not.toBeNull());
  const panel=donePanel(render({reviewPlan:null}));expect(textOf(panel)).not.toContain('Review selected plan');
  control(panel,'onboardingWizard.startExploring')();expect(mocks.push).toHaveBeenCalledWith('/dashboard');
 });
 it('a missing expired calendar hint offers explicit plan reselection without inventing a choice',()=>{
  const tree=render({reviewPlan:null,calendarStatus:'unavailable'});expect(nodes(tree).some(n=>n.props.href==='/pricing')).toBe(true);
  expect(mocks.finish).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled();
 });
});

describe('retired onboarding screen callbacks stay retired across ABA changes',()=>{
 it.each(['owner','reviewPlan'] as const)('old Finish stays invalid after %s changes away and back',kind=>{
  render();const old=finishControl(render());
  render(kind==='owner'?{expectedOwner:{userId:'33333333-3333-4333-8333-333333333333',familyId:null}}:{reviewPlan:'basic_annual'});
  render();old();expect(mocks.finish).not.toHaveBeenCalled();
 });
 it('late Finish from the first A cannot clear the current draft or display Done after A-B-A',async()=>{
  let resolve:(value:unknown)=>void=()=>{};mocks.finish.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  render();finishControl(render())();render({reviewPlan:'basic_annual'});render();
  const currentDraft=storage.get(DRAFT_STORAGE_KEY);resolve({ok:true,data:{familyId}});await Promise.resolve();await Promise.resolve();
  expect(storage.get(DRAFT_STORAGE_KEY)).toBe(currentDraft);expect(donePanel(render())).toBeNull();expect(mocks.push).not.toHaveBeenCalled();
 });
 it('retained Done review and Explore controls stay invalid after A-B-A',async()=>{
  render();finishControl(render())();await vi.waitFor(()=>expect(donePanel(render())).not.toBeNull());
  const oldReview=control(donePanel(render()),'onboardingWizard.reviewSelectedPlan');
  const oldExplore=control(donePanel(render()),'onboardingWizard.startExploring');
  render({reviewPlan:'basic_annual'});render();oldReview();oldExplore();expect(mocks.push).not.toHaveBeenCalled();
 });
});

it('a retired Finish response cannot release another screen’s pending Finish lock', async () => {
  let first: (value: unknown) => void = () => {};
  let second: (value: unknown) => void = () => {};
  mocks.finish.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
  render(); finishControl(render())();
  const current = { reviewPlan: 'basic_annual' as const };
  render(current); const finish = finishControl(render(current)); finish();
  expect(mocks.finish).toHaveBeenCalledTimes(2);
  first({ ok: true, data: { familyId } }); await Promise.resolve(); await Promise.resolve();
  finish(); expect(mocks.finish).toHaveBeenCalledTimes(2);
  expect(donePanel(render(current))).toBeNull();
  second({ ok: true, data: { familyId } });
  await vi.waitFor(() => expect(donePanel(render(current))).not.toBeNull());
  control(donePanel(render(current)), 'onboardingWizard.reviewSelectedPlan')();
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard/billing?view=manage&reviewPlan=basic_annual');
});
