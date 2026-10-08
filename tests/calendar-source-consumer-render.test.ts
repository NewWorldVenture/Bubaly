import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ReactNode } from 'react';
import { parseICSSource } from '@/lib/sync/ics-source';
import { wallAt, wallFromKey, wallKey, addWallDays } from '@/lib/time/wall-clock';
import { dayKeyIn } from '@/lib/time/zoned';

// Real Calendar/heatmap, real realtime-query ownership lifecycle, real display
// reader and actual SDK. Simulate React scheduling; no DOM/browser claim.
const h = vi.hoisted(() => ({ enabled:true,slots:[] as unknown[],cursor:0,effects:[] as (()=>void)[],cleanups:new Map<number,()=>void>(),db:null as unknown,
  family:'10000000-0000-4000-8000-000000000001',user:'user-a',timezone:'UTC',clock:null as unknown,nativeHooks:vi.fn(),requests:[] as URL[],payload:null as unknown,status:200,clientIndex:0 }));
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
vi.mock('@/lib/offline/cache-scope',()=>({useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true}));
vi.mock('@/lib/realtime/published-tables',()=>({realtimeChannelFor:()=>null}));
vi.mock('@/components/app/app-context',()=>({useApp:()=>({familyId:h.family,userId:h.user,members:[],selfMember:null})}));
vi.mock('@/components/i18n/locale-provider',()=>({useTranslations:()=>(key:string)=>key}));
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
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));h.enabled=true;h.slots=[];h.cursor=0;h.effects=[];h.cleanups.clear();h.nativeHooks.mockClear();h.family=family;h.user='user-a';h.timezone='UTC';buildClock();h.requests=[];h.payload=snapshot();h.status=200;
  const windowTarget=new EventTarget();Object.assign(windowTarget,{setInterval,clearInterval,location:{search:''},history:{replaceState:vi.fn()}});vi.stubGlobal('window',windowTarget);vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>({connected:false})})));
  h.db=createClient<Database>('https://synthetic-consumer.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,storageKey:`synthetic-consumer-${++h.clientIndex}`},global:{fetch:async(input,init)=>{const url=new URL(String(input));h.requests.push(url);expect(url.pathname).toContain('/rpc/calendar_read_occurrence_inputs');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:h.family});return Response.json(h.payload,{status:h.status});}}});
});
afterEach(()=>{h.cleanups.forEach(cleanup=>cleanup());vi.useRealTimers();vi.unstubAllGlobals();});

describe('actual web source consumer trees and query lifecycle',()=>{
  it('real SDK→reader→query→Calendar draws source chips with original keys and read-only details',async()=>{
    expect(nodes(render()).some(node=>node.type==='SkeletonList')).toBe(true);flush();await settle();let tree=render();
    expect(JSON.stringify(tree)).toContain('Private source A');expect(h.requests).toHaveLength(1);
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
    render();flush();await settle();render();expect(h.requests).toHaveLength(1);window.dispatchEvent(new Event('focus'));await settle();expect(h.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);expect(h.requests).toHaveLength(3);h.cleanups.forEach(cleanup=>cleanup());expect(vi.getTimerCount()).toBe(0);window.dispatchEvent(new Event('focus'));await settle();expect(h.requests).toHaveLength(3);
  });
  it('actual heatmap uses the same source snapshot reader instead of claiming an empty native calendar',async()=>{
    const heat=()=>{h.cursor=0;return BusynessHeatmap({familyId:h.family});};heat();flush();await settle();const tree=heat();
    expect(h.requests).toHaveLength(1);expect(nodes(tree).some(node=>typeof node.props.title==='string' && node.props.title.includes('2026-10-08: 1 event'))).toBe(true);
    h.status=400;h.payload={code:'PGRST202',message:'Synthetic missing schema'};window.dispatchEvent(new Event('focus'));await settle();expect(nodes(heat()).some(node=>node.type==='ErrorState')).toBe(true);
  });
});
