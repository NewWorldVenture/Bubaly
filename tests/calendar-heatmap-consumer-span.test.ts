import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { parseICSSource } from '@/lib/sync/ics-source';
import { cacheIdentity, writePartitionedCache } from '@/lib/offline/cache';
import { CALENDAR_DISPLAY_CONTRACT } from '@/lib/calendar/display-occurrences';
const h=vi.hoisted(()=>({enabled:true,slots:[] as unknown[],cursor:0,effects:[] as (()=>void)[],cleanups:new Map<number,()=>void>(),db:null as unknown,payload:null as unknown,timezone:'UTC',today:'2026-10-08',requests:[] as URL[],clock:null as unknown,clientIndex:0,family:"10000000-0000-4000-8000-000000000001",authScope:null as unknown,pending:null as Promise<void>|null}));
vi.mock('react',async()=>({...await vi.importActual<Record<string,unknown>>('react'),
  useState:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.slots))h.slots[i]=typeof initial==='function'?(initial as ()=>unknown)():initial;return[h.slots[i],(next:unknown)=>{h.slots[i]=typeof next==='function'?(next as (old:unknown)=>unknown)(h.slots[i]):next;}];},
  useRef:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.slots))h.slots[i]={current:initial};return h.slots[i];},
  useMemo:(factory:()=>unknown,deps:unknown[])=>{const i=h.cursor++,old=h.slots[i] as {deps:unknown[];value:unknown}|undefined;if(!old||deps.some((v,n)=>v!==old.deps[n]))h.slots[i]={deps,value:factory()};return(h.slots[i] as {value:unknown}).value;},
  useCallback:(callback:unknown,deps:unknown[])=>{const i=h.cursor++,old=h.slots[i] as {deps:unknown[];value:unknown}|undefined;if(!old||deps.some((v,n)=>v!==old.deps[n]))h.slots[i]={deps,value:callback};return(h.slots[i] as {value:unknown}).value;},
  useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const i=h.cursor++,old=h.slots[i] as unknown[]|undefined;if(!old||deps.some((v,n)=>v!==old[n])){h.slots[i]=deps;h.effects.push(()=>{h.cleanups.get(i)?.();const cleanup=effect();if(cleanup)h.cleanups.set(i,cleanup);});}},
  useSyncExternalStore:(_subscribe:unknown,snapshot:()=>unknown)=>snapshot(),
}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>h.db}));
vi.mock('@/lib/offline/cache-scope',()=>({useAuthenticatedCacheScope:()=>h.authScope,isAuthenticatedCacheScopeCurrent:()=>true}));
vi.mock('@/lib/realtime/published-tables',()=>({realtimeChannelFor:()=>null}));
vi.mock('@/components/app/app-context',()=>({useApp:()=>({familyId:'10000000-0000-4000-8000-000000000001',userId:'synthetic-user'})}));
vi.mock('@/components/i18n/locale-provider',()=>({useTranslations:()=>(key:string)=>key}));
vi.mock('@/components/i18n/use-format',()=>({useFamilyClock:()=>h.clock}));
vi.mock('@/components/ui/states',()=>({ErrorState:'ErrorState',SkeletonList:'SkeletonList'}));
import { BusynessHeatmap } from '@/components/calendar/busyness-heatmap';
const family='10000000-0000-4000-8000-000000000001',feed='20000000-0000-4000-8000-000000000001',revision='30000000-0000-4000-8000-000000000001';
type Node={type:unknown;props:Record<string,unknown>};
function nodes(v:unknown):Node[]{if(Array.isArray(v))return v.flatMap(nodes);if(!v||typeof v!=='object'||!('props'in v))return[];const n=v as Node;return[n,...Object.values(n.props).flatMap(nodes)];}
function render(){h.cursor=0;return BusynessHeatmap({familyId:h.family});}
async function read(){render();const effects=h.effects;h.effects=[];effects.forEach(effect=>effect());for(let n=0;n<40;n++)await Promise.resolve();return render();}
function titles(tree:unknown){return nodes(tree).map(n=>n.props.title).filter((v):v is string=>typeof v==='string');}
function source(lines:string){const doc=parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic heatmap//EN\r\nBEGIN:VEVENT\r\nUID:span\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];return{version:1,familyId:family,nativeRows:[],nativeCount:0,sourceCount:1,watermarkCount:1,sourceGroups:[{feedId:feed,uid:doc.uid,revisionId:revision,materializationState:'ready',document:doc,masterCancellationRevisionId:null,watermarks:[{componentKey:'master',versionComponent:structuredClone(doc.master),versionRevisionId:revision,cancelledComponent:null,cancellationRevisionId:null}]}]};}
function native(starts_at:string,ends_at:string|null,all_day=false){return{id:'40000000-0000-4000-8000-000000000001',family_id:family,title:'Synthetic',description:null,location:null,category:'general',starts_at,ends_at,all_day,recurrence:'none',recurrence_until:null,assignee_id:null,feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',source_recurrence:null};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));h.enabled=true;h.family=family;h.authScope=null;h.pending=null;h.slots=[];h.cursor=0;h.effects=[];h.cleanups.clear();h.requests=[];h.timezone='UTC';h.today='2026-10-08';h.clock={get timeZone(){return h.timezone;},todayKey:()=>h.today};const w=new EventTarget();const entries=new Map<string,string>();Object.assign(w,{setInterval,clearInterval,localStorage:{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value),removeItem:(key:string)=>entries.delete(key)}});vi.stubGlobal('window',w);vi.stubGlobal('document',{visibilityState:'visible'});h.db=createClient<Database>('https://synthetic-heatmap.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,storageKey:JSON.stringify(["synthetic-heatmap",++h.clientIndex])},global:{fetch:async(input,init)=>{const url=new URL(String(input));h.requests.push(url);if(h.pending)await h.pending;if(h.enabled){expect(url.pathname).toContain('/rpc/calendar_read_occurrence_inputs');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:h.family});return Response.json(h.payload);}return Response.json(h.payload,{headers:{'content-range':`0-0/1`}});}}});});
afterEach(()=>{h.cleanups.forEach(cleanup=>cleanup());vi.useRealTimers();vi.unstubAllGlobals();});
describe('actual SDK and heatmap span rendering',()=>{
  it('initial pending SDK read shows loading without inventing a quiet eight weeks',async()=>{
    let release!:()=>void;h.pending=new Promise<void>(resolve=>{release=resolve;});h.payload=source('DTSTART:20261008T090000Z\r\nDURATION:PT1H');
    expect(nodes(render()).some(n=>n.type==='SkeletonList')).toBe(true);
    const pending=await read();expect(h.requests).toHaveLength(1);expect(nodes(pending).some(n=>n.type==='SkeletonList')).toBe(true);expect(titles(pending)).toEqual([]);expect(JSON.stringify(pending)).not.toContain('quiet');
    h.pending=null;release();for(let n=0;n<40;n++)await Promise.resolve();expect(titles(render())).toContain('2026-10-08: 1 event · 1h');
  });
  it('family change masks prior report before effects and waits for its new SDK result',async()=>{
    h.payload=source('DTSTART:20261008T090000Z\r\nDURATION:PT1H');expect(titles(await read())).toContain('2026-10-08: 1 event · 1h');
    h.family='10000000-0000-4000-8000-000000000002';const before=render();expect(nodes(before).some(n=>n.type==='SkeletonList')).toBe(true);expect(titles(before)).toEqual([]);expect(JSON.stringify(before)).not.toContain('quiet');
    h.pending=new Promise<void>(()=>{});const after=await read();expect(nodes(after).some(n=>n.type==='SkeletonList')).toBe(true);expect(h.requests).toHaveLength(2);expect(titles(after)).toEqual([]);
  });
  it.each([0,1])('cached %i-row result refuses current load claims until actual SDK revalidation',async count=>{
    const partition={userId:'synthetic-cache-user',sessionId:'synthetic-session',accessIdentity:'synthetic-access'};
    h.authScope={key:'synthetic-cache-scope',partition,familyId:family,error:null,familyMismatchError:null};
    const identity=cacheIdentity(partition,'calendar_events',family,[family,h.today,h.timezone,CALENDAR_DISPLAY_CONTRACT,true])!;
    writePartitionedCache(identity,count?[{occurrenceKey:'cached-source',starts_at:'2026-10-08T09:00:00Z',ends_at:'2026-10-08T10:00:00Z',all_day:false}]:[]);
    let release!:()=>void;h.pending=new Promise<void>(resolve=>{release=resolve;});h.payload=source('DTSTART:20261008T110000Z\r\nDURATION:PT1H');
    const cached=await read();expect(h.requests).toHaveLength(1);expect(nodes(cached).some(n=>n.type==='ErrorState')).toBe(true);expect(titles(cached)).toEqual([]);expect(JSON.stringify(cached)).not.toContain('quiet');
    h.pending=null;release();for(let n=0;n<40;n++)await Promise.resolve();expect(nodes(render()).some(n=>n.type==='ErrorState')).toBe(false);expect(titles(render())).toContain('2026-10-08: 1 event · 1h');
  });
  it.each(['UTC','America/Los_Angeles','Asia/Tokyo'])('shows each civil DATE in a source P2D without its exclusive end in %s',async zone=>{h.timezone=zone;h.payload=source('DTSTART;VALUE=DATE:20261007\r\nDURATION:P2D');const t=titles(await read());expect(t).toContain('2026-10-07: 1 event · missionsNew.estimatedMinutes: 480');expect(t).toContain('2026-10-08: 1 event · missionsNew.estimatedMinutes: 480');expect(h.requests).toHaveLength(1);});
  it('clips source overnight actual minutes on both days',async()=>{h.payload=source('DTSTART:20261007T233000Z\r\nDURATION:PT2H');const t=titles(await read());expect(t).toContain('2026-10-07: 1 event · 0.5h');expect(t).toContain('2026-10-08: 1 event · 1.5h');});
  it('keeps a source that began before the eight-week window',async()=>{h.payload=source('DTSTART;VALUE=DATE:20260801\r\nDTEND;VALUE=DATE:20260815');const t=titles(await read());expect(t).toContain('2026-08-14: 1 event · missionsNew.estimatedMinutes: 480');expect(t).toContain('2026-08-15: 0 events');});
  it.each([['2026-03-08','20260308T080000Z','20260309T070000Z',23],['2026-11-01','20261101T070000Z','20261102T080000Z',25]] as const)('shows actual %s DST elapsed hours',async(day,start,end,hours)=>{h.timezone='America/Los_Angeles';h.today=day;vi.setSystemTime(new Date(`${day}T20:00:00Z`));h.payload=source(`DTSTART:${start}\r\nDTEND:${end}`);expect(titles(await read())).toContain(`${day}: 1 event · ${hours}h`);});
  it('disabled native actual SDK read requests overlap and clips overnight rows',async()=>{h.enabled=false;h.payload=[native('2026-10-07T23:30:00Z','2026-10-08T01:30:00Z')];const t=titles(await read());expect(t).toContain('2026-10-07: 1 event · 0.5h');expect(t).toContain('2026-10-08: 1 event · 1.5h');expect(h.requests.every(url=>url.searchParams.get('family_id')===`eq.${family}`)).toBe(true);expect(h.requests.some(url=>url.searchParams.get('or')?.includes('ends_at.gt.'))).toBe(true);});
  it('malformed native times show an error rather than calm advice',async()=>{h.enabled=false;h.payload=[native('2026-10-08T09:00:00Z','invalid')];const tree=await read();expect(nodes(tree).some(n=>n.type==='ErrorState')).toBe(true);expect(JSON.stringify(tree)).not.toContain('A quiet stretch');});
  it('disabled native DATE range occupies both civil days and excludes its end',async()=>{h.enabled=false;h.timezone='Asia/Tokyo';h.payload=[native('2026-10-06T00:00:00Z','2026-10-08T00:00:00Z',true)];const t=titles(await read());expect(t).toContain('2026-10-06: 1 event · missionsNew.estimatedMinutes: 480');expect(t).toContain('2026-10-07: 1 event · missionsNew.estimatedMinutes: 480');expect(t).toContain('2026-10-08: 0 events');});
  it('an explicit native point counts once without claiming busy minutes or nothing scheduled',async()=>{h.enabled=false;h.payload=[native('2026-10-08T00:00:00Z','2026-10-08T00:00:00Z')];const tree=await read();expect(titles(tree)).toContain('2026-10-08: 1 event');expect(JSON.stringify(tree)).not.toContain('nothing scheduled');});
});


describe('actual SDK heatmap transparency rendering',()=>{
  it.each([1,6])('shows %s free events while remaining calm without scheduled hours or packed advice',async count=>{
    const rdates=count===1?'':'\r\nRDATE:20261008T100000Z,20261008T110000Z,20261008T120000Z,20261008T130000Z,20261008T140000Z';h.payload=source(`DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT${rdates}`);
    const tree=await read();const day=nodes(tree).find(node=>node.props.title===`2026-10-08: ${count} event${count===1?'':'s'}`);expect(day).toBeDefined();expect(String(day?.props.className).split(' ')).toContain('bg-elevated');expect(JSON.stringify(tree)).not.toContain('nothing scheduled');expect(JSON.stringify(tree)).not.toContain('packed days');expect(h.requests).toHaveLength(1);
  });
  it('keeps visible mixed counts but derives workload hours only from opaque native events',async()=>{
    const value=source('DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT');Object.assign(value,{nativeRows:[native('2026-10-08T11:00:00Z','2026-10-08T12:00:00Z')],nativeCount:1});h.payload=value;const tree=await read();expect(titles(tree)).toContain('2026-10-08: 2 events · 1h');expect(JSON.stringify(tree)).not.toContain('packed days');
  });
  it('keeps transparent DATE annotations visible without the opaque eight-hour estimate',async()=>{
    h.payload=source('DTSTART;VALUE=DATE:20261007\r\nDURATION:P2D\r\nTRANSP:TRANSPARENT');const tree=await read();expect(titles(tree)).toContain('2026-10-07: 1 event');expect(titles(tree)).toContain('2026-10-08: 1 event');expect(titles(tree).filter(title=>title.includes('estimatedMinutes'))).toEqual([]);expect(JSON.stringify(tree)).not.toContain('nothing scheduled');
  });
  it('returns source metadata refusal to the existing retry state and recovers through a qualified SDK refresh',async()=>{
    h.payload=source('DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:UNKNOWN');const failed=await read();const error=nodes(failed).find(node=>node.type==='ErrorState');expect(error).toBeDefined();expect(titles(failed)).toEqual([]);expect(JSON.stringify(failed)).not.toContain('quiet');
    h.payload=source('DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT');await (error?.props.onRetry as ()=>Promise<void>)();const recovered=render();expect(nodes(recovered).some(node=>node.type==='ErrorState')).toBe(false);expect(titles(recovered)).toContain('2026-10-08: 1 event');expect(h.requests).toHaveLength(2);
  });
});


describe('actual SDK native snapshot estimates',()=>{
  it('discloses missing-end native estimates even when snapshot projection supplies actual end clocks',async()=>{
    const value=source('DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT');
    Object.assign(value,{nativeRows:[native('2026-10-08T11:00:00Z',null)],nativeCount:1});h.payload=value;
    const tree=await read();expect(titles(tree)).toContain('2026-10-08: 2 events · missionsNew.estimatedMinutes: 60');expect(h.requests).toHaveLength(1);
  });
});
