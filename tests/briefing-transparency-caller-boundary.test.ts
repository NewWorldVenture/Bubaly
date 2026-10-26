import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {orPredicate} from './helpers/in-memory-supabase';
import {NextRequest} from 'next/server';
import {parseICSSource} from '@/lib/sync/ics-source';
import type {Database,Tables} from '@/lib/database.types';
import type {ImportedSourceComponent,ImportedSourceOverride} from '@/lib/calendar/imported-source';
const h=vi.hoisted(()=>({enabled:true,db:null as unknown,provider:vi.fn(),complete:vi.fn(),configured:false,timezone:'UTC',brief:null as unknown}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>h.db}));
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:async()=>({user:{id:'60000000-0000-4000-8000-000000000001'},active:{familyId:'10000000-0000-4000-8000-000000000001',role:'parent',family:{name:'Synthetic family',timezone:h.timezone},member:{id:'50000000-0000-4000-8000-000000000001',display_name:'Synthetic parent',role:'parent'}}})}));
vi.mock('@/lib/server/route-feature-gate',()=>({refuseUnlessEntitled:async()=>null}));
vi.mock('@/lib/server/ai-rate-limit',()=>({enforceAIRateLimit:async()=>({ok:true})}));
// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); this one is the caller boundary.
vi.mock('@/lib/server/ai-access',async original=>({...(await original<typeof import('@/lib/server/ai-access')>()),withinAIAllowance:async()=>true}));
vi.mock('@/lib/ai/provider',()=>({isAIConfigured:async()=>h.configured,resolveProvider:h.provider}));
vi.mock('@/lib/i18n/server',async()=>{const {getMessages}=await import('@/lib/i18n/messages');return{getLocaleContext:async()=>({locale:{code:'en-US'},messages:getMessages('en-US')})};});
vi.mock('@/lib/ai/observability',()=>({withAiRequest:async(_scope:unknown,_details:unknown,run:(obs:{used:()=>void})=>Promise<unknown>)=>run({used:()=>{}})}));
vi.mock('@/lib/briefing/decisions',()=>({readBriefDecisions:async()=>({ok:true,data:{items:[],approvals:{},moneyApprovalKinds:{},canDecide:true}})}));
vi.mock('@/lib/briefing/build',async original=>{const actual=await original<typeof import('@/lib/briefing/build')>();return{...actual,buildBrief:(...args:Parameters<typeof actual.buildBrief>)=>{const brief=actual.buildBrief(...args);h.brief=brief;return brief;}};});
import {POST} from '@/app/api/ai/briefing/route';
import * as display from '@/lib/calendar/display-occurrences';
import {readMorningBrief} from '@/lib/briefing/deliver';
import {scopeForSystem} from '@/lib/services/scope';
const FAMILY = '10000000-0000-4000-8000-000000000001', FEED = '20000000-0000-4000-8000-000000000001';
const REVISION = '30000000-0000-4000-8000-000000000001', MEMBER = '50000000-0000-4000-8000-000000000001';
const day = '2026-10-08';
function native(index = 1, patch: Partial<Tables<'calendar_events'>> = {}) {
  return { id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, family_id: FAMILY, title: `Native ${index}`, description: null, location: null, category: 'general',
    starts_at: `${day}T09:00:00Z`, ends_at: `${day}T10:00:00Z`, all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, onboarding_key: null, idempotency_key: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', source_recurrence: null, ...patch } as Tables<'calendar_events'> & { source_recurrence: null };
}
function source(events = ['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nSUMMARY:Synthetic source'], uid = 'synthetic-source') {
  return parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic availability//EN\r\n${events.map(body => `BEGIN:VEVENT\r\nUID:${uid}\r\n${body}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`)[0];
}
function group(document = source(), feedId = FEED) {
  const components: (ImportedSourceComponent | ImportedSourceOverride)[] = [...(document.master ? [document.master] : []), ...document.overrides];
  return { feedId, uid: document.uid, revisionId: REVISION, materializationState: 'ready', document,
    masterCancellationRevisionId: document.master?.status === 'cancelled' ? REVISION : null,
    watermarks: components.map(component => ({ componentKey: 'recurrenceId' in component
      ? JSON.stringify(['override', component.recurrenceId.kind, component.recurrenceId.kind === 'zoned' ? component.recurrenceId.tzid : null, component.recurrenceId.value]) : 'master',
    versionComponent: structuredClone(component), versionRevisionId: REVISION, cancelledComponent: component.status === 'cancelled' ? structuredClone(component) : null,
    cancellationRevisionId: component.status === 'cancelled' ? REVISION : null })) };
}
function snapshot(groups = [group()], nativeRows = [native()]) {
  return { version: 1, familyId: FAMILY, nativeRows, nativeCount: nativeRows.length, sourceGroups: groups, sourceCount: groups.length, watermarkCount: groups.reduce((sum, item) => sum + item.watermarks.length, 0) };
}

function transport(value:unknown){
 const calls:{url:URL;method:string;body:unknown}[]=[];
 const db=createClient<Database>('https://brief-post.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));const method=init?.method??'GET';const body=init?.body?JSON.parse(String(init.body)):null;calls.push({url,method,body});expect(url.origin).toBe('https://brief-post.synthetic.invalid');
  if(url.pathname.includes('/rpc/')){expect(url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs');expect(body).toEqual({p_family_id:FAMILY});return Response.json(value);}
  expect(url.pathname.startsWith('/rest/v1/')).toBe(true);expect(method).toMatch(/^(GET|HEAD)$/);
  if(url.pathname.endsWith('/calendar_events')){
    expect(h.enabled).toBe(false);expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
    let rows=(value as ReturnType<typeof snapshot>).nativeRows.filter(row=>[...url.searchParams].every(([key,filter])=>{
      if(['select','order','offset','limit'].includes(key))return true;
      return key==='or'?orPredicate(filter.slice(1,-1))(row):orPredicate(`${key}.${filter}`)(row);
    }));rows=rows.sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.id.localeCompare(b.id));const offset=Number(url.searchParams.get('offset')??0),page=rows.slice(offset,offset+Math.min(2,Number(url.searchParams.get('limit')??2)));return Response.json(page,{headers:{'content-range':`${offset}-${offset+page.length-1}/${rows.length}`}});
  }
  return new Response(method==='HEAD'?null:'[]',{headers:{'Content-Type':'application/json','content-range':'*/0'}});
 }}});h.db=db;return calls;
}
async function post(){const response=await POST(new NextRequest('https://bubaly.synthetic.invalid/api/ai/briefing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'morning'})}));return{response,body:await response.json()};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));h.enabled=true;h.provider.mockClear();h.complete.mockReset();h.complete.mockResolvedValue({text:'Synthetic invalid JSON',model:'synthetic-provider'});h.provider.mockResolvedValue({complete:h.complete});h.configured=false;h.timezone='UTC';h.brief=null;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});
describe('actual POST → installed SDK → coherent source snapshot → fallback',()=>{
 it.each(['transparent','opaque'] as const)('qualifies %s source overlap without false conflict or lost visibility',async transparency=>{
  const document=source([`DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nTRANSP:${transparency.toUpperCase()}\r\nSUMMARY:Source annotation`]);const calls=transport(snapshot([group(document)],[native(1,{title:'Opaque native commitment',starts_at:'2026-10-08T18:30:00Z',ends_at:'2026-10-08T19:30:00Z'})]));
  const{response,body}=await post();expect(response.status).toBe(200);expect(body.briefing.schedule.map((row:{title:string})=>row.title)).toEqual(['Source annotation','Opaque native commitment']);expect(h.provider).not.toHaveBeenCalled();
  expect(calls.filter(call=>call.url.pathname.includes('/rpc/'))).toHaveLength(2);expect(calls.some(call=>call.url.pathname.endsWith('/calendar_events'))).toBe(false);expect(calls.some(call=>call.url.pathname.endsWith('/home_briefs'))).toBe(false);expect(calls.filter(call=>call.method!=='GET'&&call.method!=='HEAD').every(call=>call.url.pathname.includes('/rpc/'))).toBe(true);
  const expected=transparency==='transparent'?0:1;expect.soft(body.briefing.conflicts).toHaveLength(expected);expect((h.brief as {calendar:{conflicts:unknown[];todayCount:number}}).calendar).toMatchObject({todayCount:2});expect((h.brief as {calendar:{conflicts:unknown[]}}).calendar.conflicts).toHaveLength(expected);
 });
 it('refuses malformed source metadata through actual POST before provider or artifact writes',async()=>{
  const document=source(['DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nTRANSP:UNKNOWN']);const calls=transport(snapshot([group(document)],[]));const{response,body}=await post();expect(response.status).toBe(503);expect(body).toHaveProperty('error');expect(body).not.toHaveProperty('briefing');expect(h.brief).toBeNull();expect(h.provider).not.toHaveBeenCalled();expect(calls.some(call=>call.url.pathname.endsWith('/home_briefs'))).toBe(false);expect(calls.filter(call=>call.method==='POST').every(call=>call.url.pathname.includes('/rpc/'))).toBe(true);
 });
});


describe('actual morning loader → installed SDK → source snapshot',()=>{
  it.each(['transparent','opaque'] as const)('retains visible source %s while deriving only occupied clashes',async transparency=>{
    const document=source([`DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nTRANSP:${transparency.toUpperCase()}\r\nSUMMARY:Source annotation`]);const calls=transport(snapshot([group(document)],[native(1,{title:'Opaque native commitment',starts_at:'2026-10-08T18:30:00Z',ends_at:'2026-10-08T19:30:00Z'})]));
    const now=new Date('2026-10-08T12:00:00Z');const result=await readMorningBrief(scopeForSystem(h.db as Parameters<typeof scopeForSystem>[0],{id:FAMILY,timezone:'UTC'},{now}),{at:now,dayKey:day});
    expect(result.ok).toBe(true);if(!result.ok)return;expect(result.data.calendar.todayCount).toBe(2);expect(result.data.calendar.timeline.map(item=>item.title)).toEqual(['Source annotation','Opaque native commitment']);expect(result.data.calendar.conflicts).toHaveLength(transparency==='transparent'?0:1);
    const original=result.data.calendar.timeline[0];expect(original.reference).toMatchObject({kind:'source',feedId:FEED,uid:'synthetic-source',revisionId:REVISION});expect(original.occurrenceKey).toBeTruthy();expect(original).not.toHaveProperty('id');expect(calls.filter(call=>call.url.pathname.includes('/rpc/'))).toHaveLength(1);expect(calls.some(call=>call.url.pathname.endsWith('/home_briefs'))).toBe(false);expect(h.provider).not.toHaveBeenCalled();
  });
  it('refuses malformed source metadata without a calm returned brief or writes',async()=>{
    const calls=transport(snapshot([group(source(['DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nTRANSP:UNKNOWN']))],[]));const now=new Date('2026-10-08T12:00:00Z');const result=await readMorningBrief(scopeForSystem(h.db as Parameters<typeof scopeForSystem>[0],{id:FAMILY,timezone:'UTC'},{now}),{at:now,dayKey:day});expect(result.ok).toBe(false);expect(result).not.toHaveProperty('data');expect(h.provider).not.toHaveBeenCalled();expect(calls.filter(call=>call.method!=='GET'&&call.method!=='HEAD').every(call=>call.url.pathname.includes('/rpc/'))).toBe(true);
  });
});


describe('actual POST provider context and metadata admission',()=>{
  it('marks visible free annotations in the fenced provider context and retains deterministic no-clash fallback',async()=>{
    h.configured=true;const document=source(['DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Free source annotation']);transport(snapshot([group(document)],[native(1,{starts_at:'2026-10-08T18:30:00Z',ends_at:'2026-10-08T19:30:00Z'})]));const {response,body}=await post();expect(response.status).toBe(200);expect(h.complete).toHaveBeenCalledOnce();const request=h.complete.mock.calls[0][0];expect(request.messages[0].content).toContain('Free source annotation');expect(request.messages[0].content).toContain('FREE ANNOTATION: does not occupy time');expect(request.system).toContain('positive occupied opaque intervals');expect(body.briefing.schedule).toHaveLength(2);expect(body.briefing.conflicts).toEqual([]);
  });
  it.each(['timed','DATE','point'] as const)('fault injection: missing source transparency after a coherent SDK %s read refuses before provider',async kind=>{
    h.configured=true;const document=source([kind==='DATE'?'DTSTART;VALUE=DATE:20261008\r\nDURATION:P1D':kind==='point'?'DTSTART:20261008T180000Z':'DTSTART:20261008T180000Z\r\nDURATION:PT1H']);const calls=transport(snapshot([group(document)],[]));const read=display.readDisplayCalendarOccurrences;
    vi.spyOn(display,'readDisplayCalendarOccurrences').mockImplementation(async(...args)=>{const result=await read(...args);if(result.error)return result;return{...result,data:result.data.map(row=>row.kind==='source'?{...row,transparency:undefined}:row)};});
    const {response,body}=await post();expect(response.status).toBe(500);expect(body).toHaveProperty('error');expect(body).not.toHaveProperty('briefing');expect(h.complete).not.toHaveBeenCalled();expect(h.provider).not.toHaveBeenCalled();expect(h.brief).toBeNull();expect(calls.some(call=>call.url.pathname.endsWith('/home_briefs'))).toBe(false);
  });
});


describe('actual POST provider clock facts',()=>{
  it('qualifies free annotations, source/native points and native estimated ends without inventing busy intervals',async()=>{
    h.configured=true;const free=source(['DTSTART:20261008T140000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Free annotation']);const point=source(['DTSTART:20261008T150000Z\r\nSUMMARY:Source implicit point'],'point-source');
    const rows=[native(1,{title:'Native explicit point',starts_at:'2026-10-08T16:00:00Z',ends_at:'2026-10-08T16:00:00Z'}),native(2,{title:'Native estimated event',starts_at:'2026-10-08T18:00:00Z',ends_at:null})];transport(snapshot([group(free),group(point)],rows));
    const {response,body}=await post();expect(response.status).toBe(200);expect(body.briefing.schedule).toHaveLength(4);expect(body.briefing.conflicts).toEqual([]);const context=h.complete.mock.calls[0][0].messages[0].content as string;
    expect(context).toMatch(/Free annotation \[FREE ANNOTATION: does not occupy time\]/);expect(context).toMatch(/Source implicit point \[POINT ANNOTATION: zero duration; no workload or clash\]/);expect(context).toMatch(/Native explicit point \[POINT ANNOTATION: zero duration; no workload or clash\]/);expect(context).toMatch(/Native estimated event \[OPAQUE: occupied 6:00 PM–7:00 PM; actual 2026-10-08T18:00:00.000Z to 2026-10-08T19:00:00.000Z; elapsed 60 minutes; end estimated as one hour\]/);
  });
});


describe('actual SDK disabled source capability native compatibility',()=>{
  it('reads cap-two native rows completely without changing point or missing-end semantics',async()=>{
    h.enabled=false;const rows=[native(1,{title:'Native point',starts_at:'2026-10-08T15:00:00Z',ends_at:'2026-10-08T15:00:00Z'}),native(2,{title:'Estimated native',starts_at:'2026-10-08T18:00:00Z',ends_at:null}),native(3,{title:'Late actual clash',starts_at:'2026-10-08T18:30:00Z',ends_at:'2026-10-08T19:30:00Z'})];const calls=transport(snapshot([],rows));const {response,body}=await post();expect(response.status).toBe(200);expect(body.briefing.schedule.map((row:{title:string})=>row.title)).toEqual(['Native point','Estimated native','Late actual clash']);expect(body.briefing.conflicts).toHaveLength(1);expect(calls.some(call=>call.url.pathname.includes('/rpc/'))).toBe(false);expect(calls.some(call=>call.url.pathname.endsWith('/calendar_events')&&call.url.searchParams.get('offset')==='2')).toBe(true);
    const now=new Date('2026-10-08T12:00:00Z');const result=await readMorningBrief(scopeForSystem(h.db as Parameters<typeof scopeForSystem>[0],{id:FAMILY,timezone:'UTC'},{now}),{at:now,dayKey:day});expect(result.ok).toBe(true);if(result.ok){expect(result.data.calendar.todayCount).toBe(3);expect(result.data.calendar.conflicts).toHaveLength(1);}expect(calls.some(call=>call.url.pathname.endsWith('/home_briefs'))).toBe(false);
  });
});


describe('actual POST provider DST fold facts',()=>{
  it('distinguishes an elapsed hour between repeated family wall-clock times',async()=>{
    h.configured=true;h.timezone='America/Los_Angeles';vi.setSystemTime(new Date('2026-11-01T16:00:00Z'));transport(snapshot([group(source(['DTSTART:20261101T083000Z\r\nDURATION:PT1H\r\nSUMMARY:Fold commitment']))],[]));const {response,body}=await post();expect(response.status).toBe(200);expect(body.briefing.schedule).toHaveLength(1);const context=h.complete.mock.calls[0][0].messages[0].content as string;
    expect(context).toContain('Fold commitment [OPAQUE: occupied 1:30 AM–1:30 AM; actual 2026-11-01T08:30:00.000Z to 2026-11-01T09:30:00.000Z; elapsed 60 minutes]');expect(context).not.toContain('POINT ANNOTATION');
  });
});
