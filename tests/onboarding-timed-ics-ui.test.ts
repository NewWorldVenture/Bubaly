import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { DRAFT_STORAGE_KEY, emptyDraft, serializeDraftState } from '@/lib/onboarding/flow';
import { buildFirstBrief } from '@/lib/onboarding/first-brief';
import { parseIcsResult, toBriefEvents } from '@/lib/onboarding/ics';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

type Instance = { slots: unknown[]; cursor: number; effects: (() => void)[] };
type Effect = { deps: unknown[]; cleanup?: () => void };
const mock = vi.hoisted(() => ({ active: null as unknown as Instance, preview: vi.fn(), finish: vi.fn(), error: vi.fn(), locale: 'en-US' as LocaleCode }));
// Exercise actual component callbacks/state with separate parent/child lifetimes.
// Real React StrictMode and DOM behavior are additionally checked by the browser fixture.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const state = mock.active, index = state.cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const state = mock.active, index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (factory: () => unknown, deps: unknown[]) => { const state = mock.active, index = state.cursor++, old = state.slots[index] as {value:unknown;deps:unknown[]} | undefined;
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) state.slots[index] = { value: factory(), deps }; return (state.slots[index] as {value:unknown}).value; },
  useCallback: (callback: unknown) => { mock.active.cursor++; return callback; },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => { const state = mock.active, index = state.cursor++, old = state.slots[index] as Effect | undefined;
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) state.effects.push(() => { old?.cleanup?.(); state.slots[index] = { deps, cleanup: effect() }; }); },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: mock.error }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    useLocale: () => localeOrDefault(mock.locale),
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(mock.locale), key, params),
  };
});
vi.mock('@/app/onboarding/actions', () => ({ previewCalendarImportAction: mock.preview, finalizeOnboardingAction: mock.finish }));
vi.mock('@/app/onboarding/calendar-actions', () => ({ startCalendarConnectionAction: vi.fn(), previewConnectedCalendarAction: vi.fn() }));
vi.mock('@/lib/analytics/onboarding-track', () => ({ trackOnboarding: vi.fn() }));
vi.mock('@/components/outcomes/do-one-thing-card', () => ({ DoOneThingCard: () => null }));
type Node = ReactElement<Record<string, unknown>>;
const instance = (): Instance => ({ slots: [], cursor: 0, effects: [] });
function nodes(node: ReactNode): Node[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string,unknown>>(node) ? [node,...nodes(node.props.children as ReactNode)] : []; }
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join('') : isValidElement<{children?:ReactNode}>(node) ? text(node.props.children) : typeof node==='string'||typeof node==='number'?String(node):''; }
function invoke(state: Instance, component: (props: never) => ReactNode, props: unknown) { mock.active=state;state.cursor=0;const result=component(props as never);state.effects.splice(0).forEach(effect=>effect());return result; }
function unmount(state?: Instance) { for(const slot of state?.slots??[])if(slot&&typeof slot==='object'&&'cleanup'in slot)(slot as Effect).cleanup?.(); }
const t=(key:string,params?:Record<string,string|number>)=>translate(getMessages(mock.locale),key,params);
function control(node:ReactNode,key:string) { const found=nodes(node).find(item=>typeof item.props.onClick==='function'&&text(item).trim()===t(key));if(!found)throw new Error('Missing '+key);return found.props.onClick as ()=>unknown; }
const owner={userId:'11111111-1111-4111-8111-111111111111',familyId:null};
const other={userId:'33333333-3333-4333-8333-333333333333',familyId:null};
const family={...owner,familyId:'22222222-2222-4222-8222-222222222222'};
const floating='BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Private appointment\nDTSTART:20260910T090000\nDURATION:PT1H\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR';
const parsed=parseIcsResult(floating,{floatingTimezone:'America/New_York'});if(!parsed.ok)throw new Error(parsed.code);
const events=toBriefEvents(parsed.events).map(event=>({...event,recurring:false})), brief=buildFirstBrief(events,new Date('2026-09-10T12:00:00Z'),[],'America/New_York');
const result={ok:true,data:{events,brief,source:'paste',disclosure:parsed.disclosure}};
let parent:Instance,child:Instance|undefined,childKey:string|null|undefined,props:Parameters<typeof OnboardingWizard>[0],storage:Map<string,string>;
function draw() {
  let wizard=invoke(parent,OnboardingWizard,props);wizard=invoke(parent,OnboardingWizard,props);
  const panel=nodes(wizard).find(node=>typeof node.type==='function'&&node.type.name==='ValuePanel');
  if(!panel){unmount(child);child=undefined;childKey=undefined;return{wizard,value:null,panel};}
  if(!child||childKey!==panel.key){unmount(child);child=instance();childKey=panel.key;}
  const value=invoke(child,panel.type as (props:never)=>ReactNode,panel.props);return{wizard,value,panel};
}
function change(patch:Partial<typeof props>) { props={...props,...patch};return draw(); }
function start() { let view=draw();const input=nodes(view.value).find(node=>node.type==='textarea')!;(input.props.onChange as (event:unknown)=>void)({target:{value:floating}});view=draw();return control(view.value,'onboardingWizard.buildMyDay')(); }
function done() { const panel=nodes(draw().wizard).find(node=>typeof node.type==='function'&&node.type.name==='DonePanel');return panel?invoke(instance(),panel.type as (props:never)=>ReactNode,panel.props):null; }
async function finish() { for(let i=0;i<3;i++)control(draw().wizard,'phoneAuth.continue')();await control(draw().wizard,'onboardingCopy.finishSetup')(); }
beforeEach(()=>{
  parent=instance();child=undefined;childKey=undefined;props={expectedOwner:owner,reviewPlan:'basic_monthly'};mock.locale='en-US';
  storage=new Map([[DRAFT_STORAGE_KEY,serializeDraftState('value',emptyDraft({name:'Ada',familyName:'Ada family',timezone:'America/New_York'}),true)]]);
  vi.stubGlobal('window',{});vi.stubGlobal('sessionStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
  mock.preview.mockReset().mockResolvedValue(result);mock.finish.mockReset().mockResolvedValue({ok:true,data:{familyId:family.familyId,brief}});mock.error.mockReset();draw();
});
afterEach(()=>{unmount(child);unmount(parent);vi.unstubAllGlobals();});

describe('calendar import disclosure and lifecycle',()=>{
  it.each(['en-US','de-DE','es-ES','fr-FR','it-IT','nl-NL','pt-PT'] as const)('%s renders both disclosures, keeps them on revisit, and excludes them from storage and Finish',async locale=>{
    mock.locale=locale;expect(mock.preview).not.toHaveBeenCalled();expect(mock.finish).not.toHaveBeenCalled();await start();
    expect(text(draw().value)).toContain(t('calendarImport.floatingDisclosure',{timezone:'America/New_York'}));expect(text(draw().value)).toContain(t('calendarImport.recurringDisclosure'));
    expect(text(draw().value)).not.toContain('on autopilot');expect(brief.timeSavedMinutes).toBe(2);
    control(draw().wizard,'phoneAuth.continue')();draw();control(draw().wizard,'onboardingWizard.back')();expect(text(draw().value)).toContain(t('calendarImport.recurringDisclosure'));
    expect(text(draw().value)).not.toContain('on autopilot');
    expect(storage.get(DRAFT_STORAGE_KEY)).not.toMatch(/disclosure|floatingTimezone|Private appointment/);await finish();expect(JSON.stringify(mock.finish.mock.calls[0][0])).not.toMatch(/disclosure|floatingTimezone/);expect(mock.finish.mock.calls[0][0].calendarImport.events).toEqual(events);
    expect(text(done())).not.toContain('on autopilot');
  });
  it.each(['before','after'] as const)('retains the same import across a query-only change %s preview response',async timing=>{
    let resolve:(value:unknown)=>void=()=>{};mock.preview.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const pending=start();if(timing==='after'){resolve(result);await pending;draw();}
    change({reviewPlan:'plus_annual'});if(timing==='before'){resolve(result);await pending;}
    expect(text(draw().value)).toContain(t('calendarImport.recurringDisclosure'));expect(draw().panel!.props.draft).toMatchObject({importedEvents:events,calendarReceipt:undefined});expect(mock.preview).toHaveBeenCalledTimes(1);
  });
  it.each([other,family])('revokes pending preview, notices, events and receipt after owner change %j and ABA',async expectedOwner=>{
    let resolve:(value:unknown)=>void=()=>{};mock.preview.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const pending=start();change({expectedOwner});change({expectedOwner:owner});resolve(result);await pending;
    expect(text(draw().value)).not.toContain(t('calendarImport.recurringDisclosure'));expect(draw().panel!.props.draft).toMatchObject({importedEvents:[],calendarReceipt:undefined});await start();expect(draw().panel!.props.draft).toMatchObject({importedEvents:events});
  });
  it.each([other,family])('revokes retained Reset after owner change %j and preserves the new import',async expectedOwner=>{
    await start();const old=control(draw().value,'onboardingWizard.importADifferentCalendar');change({expectedOwner});change({expectedOwner:owner});await start();old();
    expect(text(draw().value)).toContain(t('calendarImport.recurringDisclosure'));await finish();expect(mock.finish.mock.calls[0][0].calendarImport.events).toEqual(events);
  });
  it('clears disclosure on explicit reset, and a new UTC import has no stale notice',async()=>{
    await start();control(draw().value,'onboardingWizard.importADifferentCalendar')();expect(draw().panel!.props.draft).toMatchObject({importedEvents:[],calendarReceipt:undefined});
    mock.preview.mockResolvedValueOnce({ok:true,data:{...result.data,disclosure:{recurring:false},events:events.map(event=>({...event,recurring:false}))}});await start();expect(text(draw().value)).not.toContain(t('calendarImport.recurringDisclosure'));
  });
  it('unmount revokes the pending response and transport failure permits an explicit retry',async()=>{
    let resolve:(value:unknown)=>void=()=>{};mock.preview.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const pending=start();control(draw().wizard,'onboardingWizard.back')();draw();resolve(result);await pending;control(draw().wizard,'phoneAuth.continue')();expect(draw().panel!.props.draft).toMatchObject({importedEvents:[]});
    mock.preview.mockRejectedValueOnce(new Error('network'));await start();expect(mock.error).toHaveBeenCalledWith(t('onboardingWizard.couldNotReadThatCalendar'));await start();expect(draw().panel!.props.draft).toMatchObject({importedEvents:events});
  });
  it.each([other,family])('masks completed brief after owner change %j and ABA while preserving query-only changes',async expectedOwner=>{
    await start();await finish();expect(text(done())).toContain(t('onboardingCopy.todayCount',{count:1}));change({reviewPlan:'plus_annual'});expect(text(done())).toContain(t('onboardingCopy.todayCount',{count:1}));
    change({expectedOwner});expect(text(done())).not.toContain(t('onboardingCopy.todayCount',{count:1}));change({expectedOwner:owner});expect(text(done())).not.toContain(t('onboardingCopy.todayCount',{count:1}));expect(mock.finish).toHaveBeenCalledTimes(1);
  });
});
