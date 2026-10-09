import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ReactNode } from 'react';
import { parseICSSource } from '@/lib/sync/ics-source';
import { wallAt, wallFromKey, wallKey, addWallDays } from '@/lib/time/wall-clock';
import { dayKeyIn } from '@/lib/time/zoned';
import { cacheIdentity, writePartitionedCache } from '@/lib/offline/cache';
import { CALENDAR_DISPLAY_CONTRACT } from '@/lib/calendar/display-occurrences';

// Real Calendar/heatmap, real realtime-query ownership lifecycle, real display
// reader and actual SDK. Simulate React scheduling; no DOM/browser claim.
const h = vi.hoisted(() => ({ enabled:true,slots:[] as unknown[],cursor:0,effects:[] as (()=>void)[],cleanups:new Map<number,()=>void>(),db:null as unknown,
  family:'10000000-0000-4000-8000-000000000001',user:'user-a',timezone:'UTC',locale:'en-US',members:[] as {id:string;display_name:string;color:string}[],clock:null as unknown,nativeHooks:vi.fn(),requests:[] as URL[],payload:null as unknown,nativeRows:[] as unknown[],status:200,clientIndex:0,authScope:null as unknown,windows:[] as {fromDay:string;toDay:string;timezone:string;overlap?:boolean;limit?:number}[],responses:[] as {body:unknown;status?:number;wait?:Promise<void>}[],realtime:false,changeCallbacks:[] as (()=>void)[] }));
vi.mock('react', async () => ({
  ...await vi.importActual<Record<string,unknown>>('react'),
  useState:(initial:unknown) => {const index = h.cursor++;if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? (initial as ()=>unknown)() : initial;return [h.slots[index],(next:unknown) => {h.slots[index] = typeof next === 'function' ? (next as (old:unknown)=>unknown)(h.slots[index]) : next;}];},
  useRef:(initial:unknown) => {const index=h.cursor++;if (!(index in h.slots)) h.slots[index]={current:initial};return h.slots[index];},
  useMemo:(factory:()=>unknown,deps:unknown[]) => {const index=h.cursor++,old=h.slots[index] as {deps:unknown[];value:unknown}|undefined;if(!old || deps.length!==old.deps.length || deps.some((value,n)=>value!==old.deps[n]))h.slots[index]={deps,value:factory()};return (h.slots[index] as {value:unknown}).value;},
  useCallback:(callback:unknown,deps:unknown[]) => {const index=h.cursor++,old=h.slots[index] as {deps:unknown[];value:unknown}|undefined;if(!old || deps.length!==old.deps.length || deps.some((value,n)=>value!==old.deps[n]))h.slots[index]={deps,value:callback};return (h.slots[index] as {value:unknown}).value;},
  useEffect:(effect:()=>void|(()=>void),deps:unknown[]) => {const index=h.cursor++,old=h.slots[index] as unknown[]|undefined;if(!old || deps.length!==old.length || deps.some((value,n)=>value!==old[n])){h.slots[index]=deps;h.effects.push(()=>{h.cleanups.get(index)?.();const cleanup=effect();if(cleanup)h.cleanups.set(index,cleanup);});}},
  useSyncExternalStore:(_subscribe:unknown,snapshot:()=>unknown)=>snapshot(),
}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>h.db}));
vi.mock('@/lib/calendar/display-occurrences',async original=>{const actual=await original<typeof import('@/lib/calendar/display-occurrences')>();return {...actual,get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;},readDisplayCalendarOccurrences:(...args:Parameters<typeof actual.readDisplayCalendarOccurrences>)=>{h.windows.push({fromDay:args[2].allDayFromDay,toDay:args[2].allDayToDay,timezone:args[3],...args[4]});return actual.readDisplayCalendarOccurrences(...args);}};});
vi.mock('@/lib/offline/cache-scope',()=>({useAuthenticatedCacheScope:()=>h.authScope,isAuthenticatedCacheScopeCurrent:()=>true}));
vi.mock('@/lib/realtime/published-tables',()=>({realtimeChannelFor:(_table:string,familyId:string)=>h.realtime?{name:`synthetic-calendar:${familyId}`,filter:`family_id=eq.${familyId}`}:null}));
vi.mock('@/components/app/app-context',()=>({useApp:()=>({familyId:h.family,userId:h.user,members:h.members,selfMember:null})}));
vi.mock('@/components/i18n/locale-provider',()=>({useTranslations:()=>(key:string)=>key,useLocale:()=>({code:h.locale})}));
vi.mock('@/components/i18n/use-format',()=>({useFamilyClock:()=>h.clock,useFormat:()=>({fmtDate:(value:string)=>value,fmtTime:(value:string)=>new Intl.DateTimeFormat('en-US',{timeZone:h.timezone,hour:'2-digit',minute:'2-digit'}).format(new Date(value))})}));
vi.mock('@/components/ui/toast',()=>({useToast:()=>({success:vi.fn(),error:vi.fn()})}));
vi.mock('@/components/ui/confirm',()=>({useConfirm:()=>{h.nativeHooks();return vi.fn();}}));
vi.mock('@/app/(app)/dashboard/calendar/actions',()=>({createCalendarEventAction:vi.fn(),updateCalendarEventAction:vi.fn(),deleteCalendarEventAction:vi.fn()}));
vi.mock('@/components/modules/find-time-modal',()=>({FindTimeModal:'FindTimeModal'}));
vi.mock('@/components/modules/routines-panel',()=>({RoutinesPanel:'RoutinesPanel'}));
vi.mock('@/components/ai/ai-insight',()=>({AiInsight:'AiInsight'}));
vi.mock('@/components/calendar/event-detail',()=>({EventScheduleInsights:'EventScheduleInsights'}));
vi.mock('@/components/ui/avatar',()=>({Avatar:'Avatar'}));
vi.mock('@/components/ui/states',()=>({ErrorState:'ErrorState',SkeletonList:'SkeletonList'}));
vi.mock('@/components/ui/modal',()=>({Modal:'Modal'}));
vi.mock('@/components/ui/button',()=>({Button:'Button'}));
vi.mock('@/components/ui/input',()=>({Input:'Input',Textarea:'Textarea',Field:'Field',Select:'Select'}));
vi.mock('@/components/app/page-header',()=>({PageHeader:'PageHeader'}));
vi.mock('next/link',()=>({default:'a'}));
import { CalendarModule } from '@/components/modules/calendar-module';
import { CalendarOccurrenceDetailModal } from '@/components/modules/event-detail-modal';
import { BusynessHeatmap } from '@/components/calendar/busyness-heatmap';

const family='10000000-0000-4000-8000-000000000001',feed='20000000-0000-4000-8000-000000000001',revision='30000000-0000-4000-8000-000000000001';
function snapshot(dateOnly=false) {
  const doc=parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic actual consumer//EN\r\nBEGIN:VEVENT\r\nUID:consumer\r\nSUMMARY:Private source A\r\nLOCATION:Synthetic location\r\nDESCRIPTION:Synthetic source detail\r\n${dateOnly?'DTSTART;VALUE=DATE:20261008\r\nDURATION:P2D':'DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=2'}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
  return {version:1,familyId:family,nativeRows:[],nativeCount:0,sourceCount:1,watermarkCount:1,sourceGroups:[{feedId:feed,uid:doc.uid,revisionId:revision,materializationState:'ready',document:doc,masterCancellationRevisionId:null,watermarks:[{componentKey:'master',versionComponent:structuredClone(doc.master),versionRevisionId:revision,cancelledComponent:null,cancellationRevisionId:null}]}]};
}
type Node={type:unknown;key?:string|null;props:Record<string,unknown>};
function nodes(value:unknown):Node[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value || typeof value!=='object' || !('props' in value))return [];const node=value as Node;return [node,...Object.values(node.props).flatMap(nodes)];}
function render(){h.cursor=0;return CalendarModule();}
function flush(){const effects=h.effects;h.effects=[];effects.forEach(effect=>effect());}
async function settle(){for(let n=0;n<35;n++)await Promise.resolve();}
function select(tree:ReactNode){const chip=nodes(tree).find(node=>node.props.role==='button' && typeof node.props.onClick==='function');expect(chip).toBeDefined();(chip!.props.onClick as ()=>void)();}
function detail(tree:ReactNode){return nodes(tree).find(node=>node.type===CalendarOccurrenceDetailModal);}
function composition(tree:ReactNode){return nodes(tree).find(node=>typeof node.type==='function' && node.type.name==='NewEventModal');}
function openComposition(tree:ReactNode){const button=nodes(tree).find(node=>node.type==='Button' && typeof node.props.onClick==='function');expect(button).toBeDefined();(button!.props.onClick as ()=>void)();}
function buildClock(){h.clock={timeZone:h.timezone,wallNow:()=>wallAt(new Date(),h.timezone),wallToday:()=>wallFromKey(dayKeyIn(new Date(),h.timezone)),todayKey:()=>dayKeyIn(new Date(),h.timezone),wallOf:(value:string)=>wallAt(new Date(value),h.timezone),wallKey,dayKeyOf:(value:string)=>dayKeyIn(new Date(value),h.timezone),addDays:addWallDays};}
beforeEach(()=>{
  h.locale='en-US';
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));h.enabled=true;h.slots=[];h.cursor=0;h.effects=[];h.cleanups.clear();h.nativeHooks.mockClear();h.family=family;h.user='user-a';h.members=[];h.timezone='UTC';buildClock();h.requests=[];h.payload=snapshot();h.nativeRows=[];h.status=200;h.authScope=null;h.windows=[];h.responses=[];h.realtime=false;h.changeCallbacks=[];
  const windowTarget=new EventTarget(),cacheEntries=new Map<string,string>();Object.assign(windowTarget,{setInterval,clearInterval,localStorage:{getItem:(key:string)=>cacheEntries.get(key)??null,setItem:(key:string,value:string)=>cacheEntries.set(key,value),removeItem:(key:string)=>cacheEntries.delete(key)},location:{search:''},history:{replaceState:vi.fn()}});vi.stubGlobal('window',windowTarget);vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>({connected:false})})));
  h.db=createClient<Database>('https://synthetic-consumer.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,storageKey:`synthetic-consumer-${++h.clientIndex}`},global:{fetch:async(input,init)=>{const url=new URL(String(input));h.requests.push(url);if(!h.enabled){expect(url.pathname).toContain('/calendar_events');const rows=url.searchParams.get('recurrence')==='neq.none'?[]:h.nativeRows;return Response.json(rows,{headers:{'content-range':`0-${Math.max(0,rows.length-1)}/${rows.length}`}});}expect(url.pathname).toContain('/rpc/calendar_read_occurrence_inputs');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:h.family});const queued=h.responses.shift();if(queued?.wait)await queued.wait;return Response.json(queued?queued.body:h.payload,{status:queued?.status??h.status});}}});
});
afterEach(()=>{h.cleanups.forEach(cleanup=>cleanup());vi.useRealTimers();vi.unstubAllGlobals();});

describe('modal instance retirement before React commits',()=>{
  for(const kind of ['draft','editor','find'] as const)for(const commitReopen of [false,true])for(const callback of ['close','save'] as const)it(`${kind}: retained ${callback} cannot affect reopened instance (committed=${commitReopen})`,async()=>{
    h.enabled=false;h.nativeRows=[nativeRow('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z')];render();flush();await settle();
    const modal=()=>kind==='find'?nodes(render()).find(node=>node.type==='FindTimeModal'):composition(render());
    const openModal=()=>{const tree=render();if(kind==='draft')openComposition(tree);else if(kind==='find'){const button=nodes(tree).find(node=>node.type==='button' && nodes(node.props.children).length>0 && JSON.stringify(node.props.children).includes('calendar.findATime'));expect(button).toBeDefined();(button!.props.onClick as ()=>void)();}else{select(tree);(detail(render())!.props.onEdit as ()=>void)();}};
    openModal();const old=modal()!;expect(old).toBeDefined();(old.props.onClose as ()=>void)();
    // Reopen in the same owner/window; the old callback runs before or after
    // the next React commit. A window-only scope cannot distinguish these.
    openModal();const next=commitReopen?modal():null;const reads=h.requests.length;
    (old.props[callback==='close'?'onClose':kind==='find'?'onScheduled':'onSaved'] as ()=>void)();await settle();const current=modal()!;
    expect(current).toBeDefined();expect(current.key).not.toBe(old.key);if(next)expect(current.key).toBe(next.key);expect(h.requests).toHaveLength(reads);
    (current.props[kind==='find'?'onScheduled':'onSaved'] as ()=>void)();await settle();expect(modal()).toBeUndefined();expect(h.requests.length).toBeGreaterThan(reads);
  });
  it('uses the reader locale with distinct family-zone fold ticks and elapsed positions',async()=>{
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));h.locale='fr-FR';h.timezone='America/New_York';buildClock();h.payload=sourceDocument('DTSTART:20261101T053000Z\r\nDTEND:20261101T063000Z');render();flush();await settle();changeView(render(),'day');const tree=render();
    const formatter=new Intl.DateTimeFormat(h.locale,{timeZone:h.timezone,hour:'2-digit',minute:'2-digit',timeZoneName:'shortOffset'});
    const expected=['2026-11-01T05:00:00Z','2026-11-01T06:00:00Z'].map(at=>formatter.format(new Date(at)));
    expect(expected[0]).not.toBe(expected[1]);for(const label of expected)expect(nodes(tree).some(node=>node.type==='span' && node.props.children===label)).toBe(true);
    const segment=nodes(tree).find(node=>node.props.style && node.props['data-calendar-start']);expect(segment?.props.style).toMatchObject({top:90/1500*1536,height:60/1500*1536});
  });
});

describe('actual web source consumer trees and query lifecycle',()=>{
  it('real SDK→reader→query→Calendar draws source chips with original keys and read-only details',async()=>{
    expect(nodes(render()).some(node=>node.type==='SkeletonList')).toBe(true);flush();await settle();let tree=render();
    expect(JSON.stringify(tree)).toContain('Private source A');expect(h.requests).toHaveLength(2);
    const chips=nodes(tree).filter(node=>node.props.role==='button');expect(chips.length).toBeGreaterThan(0);expect(chips.every(chip=>chip.key?.includes('source'))).toBe(true);
    select(tree);tree=render();const selected=detail(tree);expect(selected).toBeDefined();expect(selected?.props.occurrence).not.toHaveProperty('id');expect(selected?.props.occurrence).not.toHaveProperty('event');
    const wrapper=CalendarOccurrenceDetailModal(selected!.props as Parameters<typeof CalendarOccurrenceDetailModal>[0]);
    const content=(wrapper.type as (props:unknown)=>ReactNode)(wrapper.props);
    expect(JSON.stringify(content)).toContain('Synthetic source detail');expect(JSON.stringify(content)).not.toContain('event_rsvps');expect(h.nativeHooks).not.toHaveBeenCalled();
    expect(nodes(tree).find(node=>node.type==='RoutinesPanel')?.props.events).toEqual([]);
  });
  it('reconciles selected source to its current revision by stable occurrence key',async()=>{
    render();flush();await settle();select(render());expect(detail(render())).toBeDefined();
    const updated=snapshot();updated.sourceGroups[0].revisionId='30000000-0000-4000-8000-000000000002';updated.sourceGroups[0].watermarks[0].versionRevisionId=updated.sourceGroups[0].revisionId;h.payload=updated;
    window.dispatchEvent(new Event('focus'));await settle();const selected=detail(render());
    expect((selected?.props.occurrence as {reference:{revisionId:string}}).reference.revisionId).toBe(updated.sourceGroups[0].revisionId);
  });
  it.each(['family','user'])('masks source chips and selected details before effects after %s ownership changes',async reason=>{
    render();flush();await settle();select(render());expect(detail(render())).toBeDefined();
    if(reason==='family')h.family='10000000-0000-4000-8000-000000000002';else h.user='user-b';
    const tree=render();expect(JSON.stringify(tree)).not.toContain('Private source A');expect(detail(tree)).toBeUndefined();
  });
  it('does not resurrect source chips on an A→B→A render sequence before effects',async()=>{
    render();flush();await settle();expect(JSON.stringify(render())).toContain('Private source A');
    h.user='user-b';render();h.user='user-a';expect(JSON.stringify(render())).not.toContain('Private source A');
  });
  it('does not resurrect an old selection after a user A->B->A round trip and fresh read',async()=>{
    render();flush();await settle();select(render());expect(detail(render())).toBeDefined();
    h.user='user-b';render();flush();await settle();
    h.user='user-a';render();flush();await settle();
    expect(JSON.stringify(render())).toContain('Private source A');expect(detail(render())).toBeUndefined();
  });
  it.each(['onClose','onDeleted','onEdit'])('an old detail %s callback cannot clear a new owner selection',async callback=>{
    render();flush();await settle();select(render());const previous=detail(render())!;
    h.user='user-b';render();flush();await settle();select(render());expect(detail(render())).toBeDefined();
    const requests=h.requests.length;
    (previous.props[callback] as (event?:unknown)=>void)({title:'Old native event'});
    await settle();expect(detail(render())).toBeDefined();expect(composition(render())).toBeUndefined();expect(h.requests).toHaveLength(requests);
  });
  it.each(['family','user','timezone'])('masks an existing native editor before effects across %s changes',async reason=>{
    const value=snapshot();Object.assign(value,{nativeRows:[{id:'40000000-0000-4000-8000-000000000001',family_id:family,title:'Private native A',description:null,location:null,category:'general',starts_at:'2026-10-08T10:00:00Z',ends_at:null,all_day:false,recurrence:'none',recurrence_until:null,assignee_id:null,feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',source_recurrence:null}],nativeCount:1});h.payload=value;
    render();flush();await settle();const chip=nodes(render()).find(node=>node.props.role==='button' && JSON.stringify(node.props.children).includes('Private native A'));expect(chip).toBeDefined();(chip!.props.onClick as ()=>void)();
    const selected=detail(render());const row=selected!.props.occurrence as {kind:string;event:unknown};expect(row.kind).toBe('native');(selected!.props.onEdit as (event:unknown)=>void)(row.event);expect(composition(render())?.props.existing).toMatchObject({title:'Private native A'});
    if(reason==='family')h.family='10000000-0000-4000-8000-000000000002';else if(reason==='user')h.user='user-b';else{h.timezone='Asia/Tokyo';buildClock();}
    expect(composition(render())).toBeUndefined();expect(JSON.stringify(render())).not.toContain('Private native A');
  });
  it('owner epochs prevent drafts/find forms resurfacing after family ABA',async()=>{
    render();flush();await settle();openComposition(render());expect(composition(render())).toBeDefined();
    h.family='10000000-0000-4000-8000-000000000002';expect(composition(render())).toBeUndefined();h.family=family;expect(composition(render())).toBeUndefined();
  });
  it('an old save callback cannot close a new user composition or refresh its query',async()=>{
    render();flush();await settle();openComposition(render());const oldSave=composition(render())!.props.onSaved as ()=>void;
    h.user='user-b';render();flush();await settle();openComposition(render());expect(composition(render())).toBeDefined();const requests=h.requests.length;
    oldSave();await settle();expect(composition(render())).toBeDefined();expect(h.requests).toHaveLength(requests);
  });
  it('a failed refreshed snapshot hides retained hook data and selected detail atomically',async()=>{
    render();flush();await settle();select(render());expect(detail(render())).toBeDefined();
    h.payload={code:'PGRST202',message:'Synthetic private provider error'};h.status=400;window.dispatchEvent(new Event('focus'));await settle();const tree=render();
    expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(true);expect(JSON.stringify(tree)).not.toContain('Private source A');expect(JSON.stringify(tree)).not.toContain('private provider');expect(detail(tree)).toBeUndefined();
  });
  it('renders source DATE on its civil Tokyo day and retains distinct actual instant',async()=>{
    h.timezone='Asia/Tokyo';buildClock();h.payload=snapshot(true);render();flush();await settle();select(render());const row=detail(render())?.props.occurrence;
    expect(row).toMatchObject({startDate:'2026-10-08',endDate:'2026-10-10',starts_at:'2026-10-08T00:00:00.000Z',actualStartsAt:'2026-10-07T15:00:00.000Z'});
  });
  it('refreshes source snapshots on focus/poll and cleans up on unmount',async()=>{
    render();flush();await settle();render();expect(h.requests).toHaveLength(2);window.dispatchEvent(new Event('focus'));await settle();expect(h.requests).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);expect(h.requests).toHaveLength(6);h.cleanups.forEach(cleanup=>cleanup());expect(vi.getTimerCount()).toBe(0);window.dispatchEvent(new Event('focus'));await settle();expect(h.requests).toHaveLength(6);
  });
  it('actual heatmap uses the same source snapshot reader instead of claiming an empty native calendar',async()=>{
    const heat=()=>{h.cursor=0;return BusynessHeatmap({familyId:h.family});};heat();flush();await settle();const tree=heat();
    expect(h.requests).toHaveLength(1);expect(nodes(tree).some(node=>typeof node.props.title==='string' && node.props.title.includes('2026-10-08: 1 event'))).toBe(true);
    h.status=400;h.payload={code:'PGRST202',message:'Synthetic missing schema'};window.dispatchEvent(new Event('focus'));await settle();expect(nodes(heat()).some(node=>node.type==='ErrorState')).toBe(true);
  });
});

function sourceDocument(lines:string) {
  const document=parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic span//EN\r\nBEGIN:VEVENT\r\nUID:span\r\nSUMMARY:Span source\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
  const value=snapshot();value.sourceGroups[0].uid=document.uid;value.sourceGroups[0].document=document;value.sourceGroups[0].watermarks[0].versionComponent=structuredClone(document.master);return value;
}
function changeView(tree:ReactNode,view:string){const button=nodes(tree).find(node=>node.type==='button' && node.props.children===view);expect(button).toBeDefined();(button!.props.onClick as ()=>void)();}
function expandMonth(tree:ReactNode){const month=nodes(tree).find(node=>typeof node.type==='function' && node.type.name==='MonthGrid');expect(month).toBeDefined();return (month!.type as (props:unknown)=>ReactNode)(month!.props);}
describe('actual source spans in calendar layouts',()=>{
  it.each(['UTC','America/Los_Angeles','Asia/Tokyo'])('DATE spans occupy both days in mobile, week/day/split and month in %s',async zone=>{
    h.timezone=zone;buildClock();h.payload=sourceDocument('DTSTART;VALUE=DATE:20261007\r\nDURATION:P3D');
    h.members=[{id:'synthetic-member',display_name:'Synthetic member',color:'#fff'}];
    render();flush();await settle();let tree=render();
    const dateChips=()=>nodes(tree).filter(node=>node.props['data-occurrence-key'] && node.props.role==='button');
    expect(dateChips().map(node=>node.props['data-calendar-day'])).toContain('2026-10-08');
    expect(new Set(dateChips().map(node=>node.props['data-calendar-day']))).toEqual(new Set(['2026-10-07','2026-10-08','2026-10-09']));
    const continued=dateChips().find(node=>node.props['data-calendar-day']==='2026-10-09')!;(continued.props.onClick as ()=>void)();
    expect(detail(render())?.props.occurrence).toMatchObject({startDate:'2026-10-07',endDate:'2026-10-10'});
    changeView(tree,'day');tree=render();expect(dateChips().every(node=>node.props['data-calendar-day']==='2026-10-08')).toBe(true);
    // The split checkbox is the one wired to the side-by-side control, not category toggles.
    const controls=nodes(tree).filter(node=>node.type==='input' && node.props.type==='checkbox');
    const splitControl=controls.find(node=>String(node.props.onChange).includes('setSplitByMember'));expect(splitControl).toBeDefined();
    (splitControl!.props.onChange as (event:unknown)=>void)({target:{checked:true}});tree=render();expect(dateChips().some(node=>node.props['data-calendar-day']==='2026-10-08')).toBe(true);expect(nodes(tree).some(node=>node.type==='Avatar' && node.props.name==='Synthetic member' && node.props.size===22)).toBe(true);
    changeView(tree,'month');tree=render();const month=expandMonth(tree);
    expect(nodes(month).filter(node=>node.props['data-occurrence-key']).map(node=>node.props['data-calendar-day'])).toEqual(['2026-10-07','2026-10-08','2026-10-09']);
  });
  it('overnight source renders clipped before06 and after22 segments; both select original occurrence',async()=>{
    h.payload=sourceDocument('DTSTART:20261007T233000Z\r\nDTEND:20261008T011500Z');render();flush();await settle();let tree=render();
    const segments=nodes(tree).filter(node=>node.props.style && node.props['data-calendar-start']);
    expect(segments.map(node=>node.props['data-calendar-day'])).toEqual(['2026-10-07','2026-10-08']);
    expect(segments[0].props).toMatchObject({'data-calendar-start':'2026-10-07T23:30:00.000Z','data-calendar-end':'2026-10-08T00:00:00.000Z'});
    expect(segments[1].props).toMatchObject({'data-calendar-start':'2026-10-08T00:00:00.000Z','data-calendar-end':'2026-10-08T01:15:00.000Z'});
    expect(segments[0].props['data-occurrence-key']).toEqual(segments[1].props['data-occurrence-key']);expect(segments[0].key).not.toEqual(segments[1].key);
    for(const segment of segments){(segment.props.onClick as ()=>void)();tree=render();expect(detail(tree)?.props.occurrence).toMatchObject({starts_at:'2026-10-07T23:30:00.000Z',ends_at:'2026-10-08T01:15:00.000Z'});}
    changeView(tree,'month');expect(nodes(expandMonth(render())).filter(node=>node.props['data-occurrence-key']).map(node=>node.props['data-calendar-day'])).toEqual(['2026-10-07','2026-10-08']);
  });
  it('fold grid exposes both01:00offsets and draws actual30minute intervals distinctly',async()=>{
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));h.timezone='America/New_York';buildClock();h.payload=sourceDocument('DTSTART:20261101T051500Z\r\nDTEND:20261101T054500Z\r\nRDATE:20261101T061500Z');
    render();flush();await settle();const tree=render();const text=JSON.stringify(tree);expect(text).toContain('GMT-4');expect(text).toContain('GMT-5');
    const segments=nodes(tree).filter(node=>node.props.style && node.props['data-calendar-start']);expect(segments).toHaveLength(2);
    const geometry=segments.map(node=>node.props.style as {top:number;height:number});expect(geometry[1].top-geometry[0].top).toBeCloseTo(1536/25);expect(geometry[0].height).toBeCloseTo(1536/50);
  });
});

function nativeRow(starts_at:string,ends_at:string|null,all_day=false) {
  return {id:'40000000-0000-4000-8000-000000000001',family_id:family,title:'Synthetic native span',description:null,location:null,category:'general',starts_at,ends_at,all_day,recurrence:'none',recurrence_until:null,assignee_id:null,feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'};
}
describe('actual native SDK span projection',()=>{
  it('queries complete overlap and draws a native interval seeded before the entire42day window',async()=>{
    h.enabled=false;h.nativeRows=[nativeRow('2026-09-27T23:00:00Z','2026-10-09T01:00:00Z')];
    render();flush();await settle();const tree=render();
    const single=h.requests.find(url=>url.searchParams.get('recurrence')!=='neq.none')!;expect(single.searchParams.get('or')).toContain('ends_at.gt.2026-09-28T00:00:00.000Z');
    const segments=nodes(tree).filter(node=>node.props.style && node.props['data-calendar-start']);expect(segments).toHaveLength(5);
    expect(segments[0].props['data-calendar-day']).toBe('2026-10-05');expect(segments.at(-1)?.props['data-calendar-end']).toBe('2026-10-09T01:00:00.000Z');
    (segments[0].props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({kind:'native',starts_at:'2026-09-27T23:00:00Z',ends_at:'2026-10-09T01:00:00Z',event:{id:'40000000-0000-4000-8000-000000000001'}});
  });
  it('draws native DATE across all occupied days retaining the original event for detail',async()=>{
    h.enabled=false;h.nativeRows=[nativeRow('2026-10-07T00:00:00Z','2026-10-10T00:00:00Z',true)];render();flush();await settle();const tree=render();
    const chips=nodes(tree).filter(node=>node.props['data-occurrence-key']);expect(new Set(chips.map(node=>node.props['data-calendar-day']))).toEqual(new Set(['2026-10-07','2026-10-08','2026-10-09']));
    (chips.at(-1)!.props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({kind:'native',event:{starts_at:'2026-10-07T00:00:00Z'}});
  });
  it('malformed native single refuses the entire projection and masks previously selected data',async()=>{
    h.enabled=false;h.nativeRows=[nativeRow('2026-10-08T10:00:00Z','2026-10-08T11:00:00Z')];render();flush();await settle();select(render());expect(detail(render())).toBeDefined();
    h.nativeRows=[nativeRow('2026-10-08T10:00:00Z','2026-10-08T09:00:00Z')];
    const routines=nodes(render()).find(node=>node.type==='RoutinesPanel');
    expect(routines).toBeDefined();(routines!.props.onApplied as ()=>void)();await settle();
    const tree=render();expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(true);expect(detail(tree)).toBeUndefined();expect(nodes(tree).some(node=>node.props['data-occurrence-key'])).toBe(false);
  });
});

describe('actual spring timeline and source grid clipping',()=>{
  it('spring23hour day skips the nonexistent02:00 walltick and scales real60minutes',async()=>{
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));h.timezone='America/New_York';buildClock();h.payload=sourceDocument('DTSTART:20260308T063000Z\r\nDTEND:20260308T073000Z');render();flush();await settle();
    let tree=render();changeView(tree,'day');tree=render();const labels=nodes(tree).filter(node=>node.type==='span' && typeof node.props.children==='string' && node.props.children.includes('GMT')).map(node=>String(node.props.children));
    expect(labels).toHaveLength(23);expect(labels.some(label=>label.includes('02:00 AM'))).toBe(false);expect(labels.some(label=>label.includes('GMT-5'))).toBe(true);expect(labels.some(label=>label.includes('GMT-4'))).toBe(true);
    const segment=nodes(tree).find(node=>node.props.style && node.props['data-calendar-start']);expect(segment?.props.style).toMatchObject({top:90/1380*1536,height:60/1380*1536});
  });
  it('source DATE seeded before whole grid appears only on occupied in-grid dates, with original source detail',async()=>{
    h.payload=sourceDocument('DTSTART;VALUE=DATE:20260927\r\nDTEND;VALUE=DATE:20261009');render();flush();await settle();let tree=render();changeView(tree,'month');tree=render();const month=expandMonth(tree);
    const chips=nodes(month).filter(node=>node.props['data-occurrence-key']);expect(chips).toHaveLength(11);expect(chips[0].props['data-calendar-day']).toBe('2026-09-28');expect(chips.at(-1)?.props['data-calendar-day']).toBe('2026-10-08');
    (chips[0].props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({kind:'source',startDate:'2026-09-27',endDate:'2026-10-09'});
  });
});

describe('actual continuation labels and near-midnight markers',()=>{
  it('upcoming sidebar labels the clipped Today continuation and opens the complete original source',async()=>{
    h.payload=sourceDocument('DTSTART:20261007T233000Z\r\nDTEND:20261008T011500Z');render();flush();await settle();
    const tree=render(),continuation=nodes(tree).find(node=>node.props['data-calendar-sidebar-day']==='2026-10-08');
    expect(continuation).toBeDefined();expect(continuation!.props['data-calendar-sidebar-start']).toBe('2026-10-08T00:00:00.000Z');
    const clippedLabel=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date('2026-10-08T00:00:00Z'));
    expect(JSON.stringify(continuation!.props.children)).toContain(clippedLabel);
    (continuation!.props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({starts_at:'2026-10-07T23:30:00.000Z',ends_at:'2026-10-08T01:15:00.000Z'});
  });
  it.each(['point','short'])('%s at the final millisecond retains a24px in-grid marker with actual metadata',async kind=>{
    h.enabled=false;h.nativeRows=[nativeRow(kind==='point'?'2026-10-08T23:59:59.999Z':'2026-10-08T23:59:59.000Z','2026-10-08T23:59:59.999Z')];
    render();flush();await settle();const segment=nodes(render()).find(node=>node.props.style && node.props['data-calendar-start']);
    expect(segment).toBeDefined();expect(segment!.props.style).toMatchObject({top:1512,height:24});
    expect(segment!.props['data-calendar-end']).toBe('2026-10-08T23:59:59.999Z');
    (segment!.props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({starts_at:(h.nativeRows[0] as {starts_at:string}).starts_at,ends_at:'2026-10-08T23:59:59.999Z'});
  });
});

describe('actual vanished civil date rendering',()=>{
  it.each(['DATE','timed'])('%s keeps appropriate Apia dates and leaves other days usable',async kind=>{
    vi.setSystemTime(new Date('2011-12-29T12:00:00Z'));h.timezone='Pacific/Apia';buildClock();
    h.payload=sourceDocument(kind==='DATE'?'DTSTART;VALUE=DATE:20111229\r\nDTEND;VALUE=DATE:20120101':'DTSTART:20111229T100000Z\r\nDTEND:20111231T100000Z');
    render();flush();await settle();let tree=render();expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(false);
    if(kind==='timed'){
      const segments=nodes(tree).filter(node=>node.props.style && node.props['data-calendar-start']);
      expect(segments.map(node=>node.props['data-calendar-day'])).toEqual(['2011-12-29','2011-12-31']);
      expect(segments.every(node=>Number.isFinite((node.props.style as {top:number}).top))).toBe(true);
    }
    changeView(tree,'month');tree=render();const chips=nodes(expandMonth(tree)).filter(node=>node.props['data-occurrence-key']);
    expect(chips.map(node=>node.props['data-calendar-day'])).toEqual(kind==='DATE'?['2011-12-29','2011-12-30','2011-12-31']:['2011-12-29','2011-12-31']);
    (chips[0].props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({kind:'source'});
  });
});

function sidebar(tree:ReactNode){return nodes(tree).filter(node=>node.props['data-calendar-sidebar-day']);}
async function navigateWeeks(direction:'calendar.next'|'calendar.previous',count:number){for(let step=0;step<count;step++){const button=nodes(render()).find(node=>node.type==='button'&&node.props['aria-label']===direction);expect(button).toBeDefined();(button!.props.onClick as ()=>void)();render();flush();await settle();}}
function revisedSnapshot(value=structuredClone(snapshot())){value.sourceGroups[0].revisionId='30000000-0000-4000-8000-000000000002';value.sourceGroups[0].watermarks[0].versionRevisionId=value.sourceGroups[0].revisionId;return value;}
describe('independent complete next-seven-day sidebar and original references',()=>{
  it.each(['calendar.next','calendar.previous'] as const)('survives fifteen %s week navigations and selects source outside the grid',async direction=>{
    render();flush();await settle();expect(sidebar(render()).map(node=>node.props['data-calendar-sidebar-day'])).toEqual(['2026-10-08','2026-10-09']);
    const reads=h.windows.filter(window=>window.fromDay==='2026-10-08'&&window.toDay==='2026-10-15');expect(reads).toHaveLength(1);expect(reads[0]).toMatchObject({timezone:'UTC',overlap:true});expect(reads[0].limit).toBeUndefined();
    await navigateWeeks(direction,15);const tree=render();expect(nodes(tree).filter(node=>node.props['data-calendar-day'])).toHaveLength(0);expect(sidebar(tree)).toHaveLength(2);expect(JSON.stringify(tree)).not.toContain('calendar.nothingComingUp');
    expect(h.windows.filter(window=>window.fromDay==='2026-10-08'&&window.toDay==='2026-10-15')).toHaveLength(1);
    (sidebar(tree)[0].props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({kind:'source',starts_at:'2026-10-08T09:00:00.000Z'});
    await navigateWeeks(direction,2);expect(detail(render())).toBeDefined();expect(sidebar(render())).toHaveLength(2);
  });
  it('seven-day range remains complete across the selected42day grid month edge',async()=>{
    vi.setSystemTime(new Date('2027-01-08T12:00:00Z'));buildClock();h.payload=sourceDocument('DTSTART:20270114T090000Z\r\nDURATION:PT1H');render();flush();await settle();await navigateWeeks('calendar.previous',1);const tree=render();
    expect(h.windows).toEqual(expect.arrayContaining([expect.objectContaining({fromDay:'2026-11-30',toDay:'2027-01-11'}),expect.objectContaining({fromDay:'2027-01-08',toDay:'2027-01-15'})]));
    expect(nodes(tree).filter(node=>node.props['data-calendar-day'])).toHaveLength(0);expect(sidebar(tree).map(node=>node.props['data-calendar-sidebar-day'])).toEqual(['2027-01-14']);
    (sidebar(tree)[0].props.onClick as ()=>void)();expect(detail(render())?.props.occurrence).toMatchObject({kind:'source',starts_at:'2027-01-14T09:00:00.000Z'});
  });
  it('uses the sidebar current revision rather than the same original key from the grid snapshot',async()=>{
    const newer=revisedSnapshot();h.responses=[{body:snapshot()},{body:newer}];render();flush();await settle();
    (sidebar(render())[0].props.onClick as ()=>void)();expect((detail(render())?.props.occurrence as {reference:{revisionId:string}}).reference.revisionId).toBe(newer.sourceGroups[0].revisionId);
    const latest=revisedSnapshot();latest.sourceGroups[0].revisionId='30000000-0000-4000-8000-000000000003';latest.sourceGroups[0].watermarks[0].versionRevisionId=latest.sourceGroups[0].revisionId;h.responses=[{body:snapshot()},{body:latest}];window.dispatchEvent(new Event('focus'));await settle();
    expect((detail(render())?.props.occurrence as {reference:{revisionId:string}}).reference.revisionId).toBe(latest.sourceGroups[0].revisionId);
  });
  it('failed sidebar refresh masks retained rows/detail and retries only its independent query',async()=>{
    render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();expect(detail(render())).toBeDefined();
    h.responses=[{body:snapshot()},{body:{code:'PGRST202',message:'Synthetic private failure'},status:400}];window.dispatchEvent(new Event('focus'));await settle();let tree=render();
    expect(sidebar(tree)).toHaveLength(0);expect(detail(tree)).toBeUndefined();expect(JSON.stringify(tree)).not.toContain('calendar.nothingComingUp');expect(nodes(tree).some(node=>node.props['data-calendar-day'])).toBe(true);
    const retry=nodes(tree).find(node=>node.type==='ErrorState');expect(retry).toBeDefined();const count=h.requests.length;h.responses=[{body:revisedSnapshot()}];(retry!.props.onRetry as ()=>void)();await settle();tree=render();
    expect(h.requests).toHaveLength(count+1);expect(sidebar(tree)).toHaveLength(2);expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(false);
  });
  it('a failed grid leaves the independently successful sidebar and details usable',async()=>{
    h.responses=[{body:{code:'PGRST202',message:'Synthetic grid failure'},status:400},{body:snapshot()}];render();flush();await settle();let tree=render();
    expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(true);expect(sidebar(tree)).toHaveLength(2);(sidebar(tree)[0].props.onClick as ()=>void)();tree=render();expect(detail(tree)?.props.occurrence).toMatchObject({kind:'source'});
  });
  it('independent pending sidebar shows loading without an empty claim while the grid is already usable',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});h.responses=[{body:snapshot()},{body:snapshot(),wait}];render();flush();await settle();let tree=render();
    expect(nodes(tree).some(node=>node.props['data-calendar-day'])).toBe(true);expect(nodes(tree).some(node=>node.type==='SkeletonList')).toBe(true);expect(sidebar(tree)).toHaveLength(0);expect(JSON.stringify(tree)).not.toContain('calendar.nothingComingUp');
    release();await settle();tree=render();expect(sidebar(tree)).toHaveLength(2);expect(nodes(tree).some(node=>node.type==='SkeletonList')).toBe(false);
  });
  it.each([0,1])('cached%i-row sidebar prefix cannot claim completeness or revive details until SDK revalidation',async count=>{
    const partition={userId:h.user,sessionId:'synthetic-session',accessIdentity:'synthetic-access'};h.authScope={key:'synthetic-cache-scope',partition,familyId:family,error:null,familyMismatchError:null};
    const identity=cacheIdentity(partition,'calendar_events',family,['calendar-upcoming-v1',family,h.user,'2026-10-08','2026-10-15','UTC',CALENDAR_DISPLAY_CONTRACT,true])!;
    writePartitionedCache(identity,count?[{occurrenceKey:'cached-private',title:'Cached private source'}]:[]);
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});h.responses=[{body:snapshot()},{body:snapshot(),wait}];render();flush();await settle();let tree=render();
    expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(true);expect(sidebar(tree)).toHaveLength(0);expect(JSON.stringify(tree)).not.toContain('Cached private source');expect(JSON.stringify(tree)).not.toContain('calendar.nothingComingUp');expect(detail(tree)).toBeUndefined();
    release();await settle();tree=render();expect(sidebar(tree)).toHaveLength(2);expect(nodes(tree).some(node=>node.type==='ErrorState')).toBe(false);
  });
  it.each(['onClose','onDeleted','onEdit'])('old sidebar%s callback cannot affect a later grid selection or issue reads',async callback=>{
    render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();const old=detail(render())!;select(render());expect(detail(render())).toBeDefined();const count=h.requests.length;
    (old.props[callback] as (event?:unknown)=>void)({title:'Synthetic old native'});await settle();expect(detail(render())).toBeDefined();expect(composition(render())).toBeUndefined();expect(h.requests).toHaveLength(count);
  });
  it.each(['family','user'])('sidebar%s A→B→A ownership masks data and never resurrects selection before effects',async reason=>{
    render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();expect(detail(render())).toBeDefined();
    const original=reason==='family'?h.family:h.user;if(reason==='family')h.family='10000000-0000-4000-8000-000000000002';else h.user='user-b';render();if(reason==='family')h.family=original;else h.user=original;
    const tree=render();expect(sidebar(tree)).toHaveLength(0);expect(detail(tree)).toBeUndefined();flush();await settle();expect(sidebar(render())).toHaveLength(2);expect(detail(render())).toBeUndefined();
  });
  it('a stale saved callback after grid navigation cannot refresh the still-current sidebar query',async()=>{
    render();flush();await settle();openComposition(render());const save=composition(render())!.props.onSaved as ()=>void;await navigateWeeks('calendar.next',8);openComposition(render());expect(composition(render())).toBeDefined();const count=h.requests.length;
    save();await settle();expect(composition(render())).toBeDefined();expect(h.requests).toHaveLength(count);
  });
  it('family-midnight wake rolls the seven-day window, masks yesterday selection and cleans up timers',async()=>{
    vi.setSystemTime(new Date('2026-10-08T23:59:59Z'));buildClock();render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();expect(detail(render())).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);let tree=render();expect(detail(tree)).toBeUndefined();expect(sidebar(tree)).toHaveLength(0);flush();await settle();tree=render();
    expect(h.windows).toEqual(expect.arrayContaining([expect.objectContaining({fromDay:'2026-10-09',toDay:'2026-10-16'})]));expect(sidebar(tree).map(node=>node.props['data-calendar-sidebar-day'])).toEqual(['2026-10-09']);
    h.cleanups.forEach(cleanup=>cleanup());expect(vi.getTimerCount()).toBe(0);
  });
});

describe('independent sidebar callbacks and native realtime boundary',()=>{
  it.each(['onClose','onDeleted','onEdit'])('old sidebar%s from another user cannot change new sidebar selection or refresh',async callback=>{
    render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();const old=detail(render())!;
    h.user='user-b';render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();const count=h.requests.length;
    (old.props[callback] as (event?:unknown)=>void)({title:'Synthetic stale native'});await settle();expect(detail(render())).toBeDefined();expect(composition(render())).toBeUndefined();expect(h.requests).toHaveLength(count);
  });
  it('old native upcoming edit after grid navigation neither closes detail nor opens a stale editor; latest callback opens current original',async()=>{
    h.enabled=false;h.nativeRows=[nativeRow('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z')];render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();const old=detail(render())!;
    await navigateWeeks('calendar.next',8);expect(detail(render())).toBeDefined();(old.props.onEdit as (event:unknown)=>void)(nativeRow('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z'));
    expect(detail(render())).toBeDefined();expect(composition(render())).toBeUndefined();(detail(render())!.props.onEdit as (event:unknown)=>void)({title:'Ignored callback argument'});
    expect(composition(render())?.props.existing).toMatchObject({id:'40000000-0000-4000-8000-000000000001',title:'Synthetic native span',starts_at:'2026-10-08T09:00:00Z'});
  });
  it('each native query owns a distinct realtime subscription and both re-read complete collections on change',async()=>{
    h.enabled=false;h.realtime=true;h.nativeRows=[nativeRow('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z')];
    const db=h.db as ReturnType<typeof createClient<Database>>;
    const channelSpy=vi.spyOn(db,'channel').mockImplementation(()=>{const channel={on:vi.fn((_kind:unknown,_filter:unknown,callback:()=>void)=>{h.changeCallbacks.push(callback);return channel;}),subscribe:vi.fn(()=>channel)};return channel as unknown as RealtimeChannel;});
    const remove=vi.spyOn(db,'removeChannel').mockResolvedValue('ok');
    render();flush();await settle();expect(channelSpy).toHaveBeenCalledTimes(2);expect(new Set(channelSpy.mock.calls.map(args=>args[0])).size).toBe(2);expect(h.changeCallbacks).toHaveLength(2);
    const count=h.requests.length;h.nativeRows=[{...nativeRow('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z'),title:'Updated synthetic native'}];h.changeCallbacks.forEach(callback=>callback());await settle();
    expect(h.requests).toHaveLength(count+4);expect(JSON.stringify(sidebar(render()))).toContain('Updated synthetic native');
    h.cleanups.forEach(cleanup=>cleanup());expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe('sidebar selection retirement before React commits',()=>{
  it.each(['onClose','onDeleted','onEdit'])('old%s cannot overwrite a newly queued selection before any render',async callback=>{
    render();flush();await settle();(sidebar(render())[0].props.onClick as ()=>void)();const tree=render(),old=detail(tree)!;
    const other=sidebar(tree)[1];expect(other).toBeDefined();const reads=h.requests.length;
    (other.props.onClick as ()=>void)();(old.props[callback] as (event?:unknown)=>void)({title:'Synthetic old row'});
    await settle();expect(detail(render())?.props.occurrence).toMatchObject({starts_at:'2026-10-09T09:00:00.000Z'});expect(composition(render())).toBeUndefined();expect(h.requests).toHaveLength(reads);
  });
  it.each([['2026-03-09T03:59:59Z','2026-03-08','2026-03-09'],['2026-11-02T04:59:59Z','2026-11-01','2026-11-02']])('midnight after DST day at%s rolls on the actual boundary',async (at,from,next)=>{
    vi.setSystemTime(new Date(at));h.timezone='America/New_York';buildClock();h.payload=sourceDocument(`DTSTART;VALUE=DATE:${from.replaceAll('-','')}\r\nDURATION:P2D`);
    render();flush();await settle();expect(sidebar(render())[0].props['data-calendar-sidebar-day']).toBe(from);
    await vi.advanceTimersByTimeAsync(1000);render();flush();await settle();expect(sidebar(render())[0].props['data-calendar-sidebar-day']).toBe(next);
    expect(h.windows.some(window=>window.fromDay===next&&window.toDay===new Date(Date.parse(`${next}T00:00:00Z`)+7*86_400_000).toISOString().slice(0,10))).toBe(true);
  });
});
