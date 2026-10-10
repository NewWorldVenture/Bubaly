import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {createClient} from '@supabase/supabase-js';
import type {Database} from '@/lib/database.types';
const h=vi.hoisted(()=>({ics:'',db:null as unknown,inserted:[] as Record<string,unknown>[],requests:[] as URL[],fetchCalendar:vi.fn(),rate:vi.fn(),context:vi.fn(),writeError:false}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:h.context}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>h.db}));
vi.mock('@/lib/server/request-rate-limit',()=>({enforceRequestRateLimit:h.rate}));
vi.mock('@/lib/server/public-calendar-fetch',()=>({fetchPublicCalendarText:h.fetchCalendar}));
import {POST} from '@/app/api/calendar/sync/route';
const family='10000000-0000-4000-8000-000000000001',user='20000000-0000-4000-8000-000000000001';
const component=(lines:string,uid='synthetic')=>`BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Synthetic event\r\n${lines}\r\nEND:VEVENT`;
const calendar=(...events:string[])=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic fixture//EN\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const request=(body:unknown={icsUrl:'https://calendar.example/synthetic.ics',label:'Synthetic source'})=>new NextRequest('https://fixture.invalid/api/calendar/sync',{method:'POST',body:JSON.stringify(body)});
beforeEach(()=>{
 vi.clearAllMocks();h.inserted=[];h.requests=[];h.writeError=false;h.ics=calendar(component('DTSTART;VALUE=DATE:20261008'));h.context.mockResolvedValue({user:{id:user},active:{familyId:family,role:'parent'}});h.rate.mockResolvedValue({ok:true});h.fetchCalendar.mockImplementation(async()=>({ok:true,text:h.ics}));vi.spyOn(console,'error').mockImplementation(()=>{});
 h.db=createClient<Database>('https://synthetic-import.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));h.requests.push(url);expect(url.origin).toBe('https://synthetic-import.invalid');expect(url.pathname).toBe('/rest/v1/calendar_events');expect(init?.method).toBe('POST');
  if(h.writeError)return Response.json({code:'42501',message:'Synthetic RLS refusal'},{status:403});
  h.inserted.push(...JSON.parse(String(init?.body)));return new Response(null,{status:201});
 }}});
});
afterEach(()=>vi.restoreAllMocks());
describe('actual request → alternate calendar import → SDK native boundary',()=>{
 it.each([
  ['DTSTART;TZID=America/New_York:20261101T090000\r\nDTEND;TZID=America/New_York:20261101T100000','2026-11-01T14:00:00.000Z','2026-11-01T15:00:00.000Z'],
  ['DTSTART;TZID=America/New_York:20260308T090000\r\nDTEND;TZID=America/New_York:20260308T100000','2026-03-08T13:00:00.000Z','2026-03-08T14:00:00.000Z'],
  ['DTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z','2026-10-08T09:00:00.000Z','2026-10-08T10:00:00.000Z'],
 ])('keeps explicit timed oneoff actual instants from %s',async(lines,start,end)=>{
  h.ics=calendar(component(lines));const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({imported:1,total:1});expect(h.inserted[0]).toEqual({family_id:family,title:'Synthetic event',description:'[Imported from Synthetic source]\n[UID: synthetic]',location:null,starts_at:start,ends_at:end,all_day:false,recurrence:'none',category:'general'});
 });
 it.each(['','RRULE:FREQ=DAILY','RRULE:FREQ=WEEKLY'])('retains civil DATE and admitted native cadence %s',async rule=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261103'+(rule?'\r\n'+rule:'')));expect((await POST(request())).status).toBe(200);expect(h.inserted[0]).toMatchObject({starts_at:'2026-11-01T00:00:00.000Z',ends_at:'2026-11-03T00:00:00.000Z',all_day:true,recurrence:rule.includes('DAILY')?'daily':rule?'weekly':'none'});
 });
 it('omits a cancelled master without creating an active native row or deleting previous copies',async()=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261008\r\nSTATUS:CANCELLED'));const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({imported:0});expect(h.requests).toEqual([]);
 });
 it.each(['','TRANSP:OPAQUE','transp:opaque'])('preserves opaque/default native copies with metadata %s',async metadata=>{
  h.ics=calendar(component('DTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z'+(metadata?'\r\n'+metadata:'')));
  const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({imported:1,total:1});expect(h.inserted).toHaveLength(1);expect(h.inserted[0]).toMatchObject({starts_at:'2026-10-08T09:00:00.000Z',ends_at:'2026-10-08T10:00:00.000Z'});
 });
 it.each(['TRANSP:TRANSPARENT','transp:transparent','TRANSP:TRANSPA\r\n RENT','TRANSP:UNKNOWN','TRANSP:','TRANSP: OPAQUE','TRANSP:OPAQUE\r\nTRANSP:OPAQUE','TRANSP:OPAQUE\r\nTRANSP:TRANSPARENT','TRANSP;X-UNKNOWN=VALUE:OPAQUE','TRANSP;X-UNKNOWN="a:b":OPAQUE'])('refuses a mixed calendar before any native write for metadata %s',async metadata=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261005','safe-first'),component('DTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z\r\n'+metadata,'unsafe-last'));
  const response=await POST(request());expect(response.status).toBe(422);expect(await response.json()).toEqual({error:'calendarImport.invalidCalendar'});expect(h.requests).toEqual([]);expect(h.inserted).toEqual([]);
 });
 it('refuses late transparent metadata beyond the first potential write chunk',async()=>{
  h.ics=calendar(...Array.from({length:201},(_,i)=>component('DTSTART;VALUE=DATE:20261008',`safe-${i}`)),component('DTSTART;VALUE=DATE:20261008\r\nTRANSP:TRANSPARENT','unsafe-last'));
  expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);
 });
 it.each(['TRANSP:TRANSPARENT','TRANSP:OPAQUE'])('omits a valid cancelled %s component while preserving a live opaque sibling',async metadata=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261005','safe-first'),component('DTSTART;VALUE=DATE:20261008\r\nSTATUS:CANCELLED\r\n'+metadata,'cancelled'));
  const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({imported:1,total:1});expect(h.inserted).toHaveLength(1);expect(h.inserted[0].description).toContain('UID: safe-first');
 });
 it.each(['TRANSP:OPAQUE\r\nTRANSP:TRANSPARENT','TRANSP;X-UNKNOWN=VALUE:OPAQUE'])('refuses malformed cancelled metadata %s before a live sibling is copied',async metadata=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261005','safe-first'),component('DTSTART;VALUE=DATE:20261008\r\nSTATUS:CANCELLED\r\n'+metadata,'cancelled'));
  expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);
 });
 it.each([
  'DTSTART;VALUE=DATE:20261008\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=2\r\nEXDATE;VALUE=DATE:20261022',
  'DTSTART;VALUE=DATE:20261008\r\nRRULE:FREQ=MONTHLY',
  'DTSTART;VALUE=DATE:20261008\r\nRRULE:FREQ=WEEKLY\r\nRRULE:FREQ=DAILY',
  'DTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z\r\nRRULE:FREQ=WEEKLY',
  'DTSTART:20261008T090000Z',
  'DTSTART:20261008T090000Z\r\nDTEND:20261008T090000Z',
  'DTSTART;VALUE=DATE:20261008\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nDESCRIPTION:Alarm\r\nEND:VALARM',
  'DTSTART:20261008T090000\r\nDTEND:20261008T100000',
  'DTSTART:20261008T090000Z\r\nDURATION:PT1H',
  'DTSTART;VALUE=DATE:20261008\r\nDURATION:P2D',
  'DTSTART;VALUE=DATE:20261008\r\nRDATE;VALUE=DATE:20261009',
  'DTSTART;VALUE=DATE:20261008\r\nRECURRENCE-ID;VALUE=DATE:20261008',
  'DTSTART;TZID=Unknown/Zone:20261008T090000\r\nDTEND;TZID=Unknown/Zone:20261008T100000',
  'DTSTART;VALUE=DATE:20260230',
  'DTSTART;VALUE=DATE:20261008\r\nDTEND;VALUE=DATE:20261007',
  'DTSTART;VALUE=DATE:20261008\r\nDTEND;VALUE=DATE:20261008',
  'DTSTART;VALUE=DATE:20261008\r\nDTEND:20261009T100000Z',
  'DTSTART:20261008T100000Z\r\nDTEND:20261008T090000Z',
 ])('refuses the entire mixed calendar before ANY insert: %s',async unsupported=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261005','safe-first'),component(unsupported,'unsafe-last'));const response=await POST(request());expect(response.status).toBe(422);expect(await response.json()).toEqual({error:'calendarImport.invalidCalendar'});expect(h.requests).toEqual([]);
 });
 it('imports case-insensitive component delimiters without changing original text values',async()=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261008','MiXeD-uid').replace('BEGIN:VEVENT','begin:vevent').replace('END:VEVENT','end:vevent'));
  const response=await POST(request());expect(response.status).toBe(200);expect(h.inserted).toHaveLength(1);expect(h.inserted[0].description).toBe('[Imported from Synthetic source]\n[UID: MiXeD-uid]');
 });
 it('refuses a lowercase unsupported final component before writing a safe prefix',async()=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261008','safe'),component('DTSTART;VALUE=DATE:20261008\r\nRRULE:FREQ=MONTHLY','unsafe').replace('BEGIN:VEVENT','begin:vevent').replace('END:VEVENT','end:vevent'));
  expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);
 });
 it('qualifies components beyond the first 200-row write chunk before any mutation',async()=>{
  h.ics=calendar(...Array.from({length:201},(_,i)=>component('DTSTART;VALUE=DATE:20261008',`safe-${i}`)),component('DTSTART;VALUE=DATE:20261008\r\nRRULE:FREQ=MONTHLY','unsafe-last'));
  expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);
 });
 it('imports every admitted row across chunks using only the authenticated family',async()=>{
  h.ics=calendar(...Array.from({length:201},(_,i)=>component('DTSTART;VALUE=DATE:20261008',`safe-${i}`)));
  const response=await POST(request({icsUrl:'https://calendar.example/synthetic.ics',familyId:'spoof-family',userId:'spoof-user'}));expect(response.status).toBe(200);expect(await response.json()).toEqual({imported:201,total:201});expect(h.requests).toHaveLength(2);expect(h.inserted).toHaveLength(201);expect(h.inserted.every(row=>row.family_id===family)).toBe(true);expect(new Set(h.inserted.map(row=>row.description)).size).toBe(201);
 });
 it('refuses multiple UID revisions rather than reviving an older cancelled source',async()=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261008'),component('DTSTART;VALUE=DATE:20261008\r\nSTATUS:CANCELLED'));expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);
 });
 it('does not silently drop an incomplete component next to a valid one',async()=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261008'),'BEGIN:VEVENT\r\nUID:missing-start\r\nSUMMARY:Missing start\r\nEND:VEVENT');expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);
 });
 it('retains escaped title/description/location and original UID provenance',async()=>{
  h.ics=calendar(component('DTSTART;VALUE=DATE:20261008\r\nDESCRIPTION:Line one\\nLine two\\, ok\r\nLOCATION:Hall\\; east').replace('SUMMARY:Synthetic event','SUMMARY:Synthetic\\, title'));expect((await POST(request())).status).toBe(200);expect(h.inserted[0]).toMatchObject({title:'Synthetic, title',description:'Line one\nLine two, ok\n[UID: synthetic]',location:'Hall; east'});
 });
 it('preserves guarded fetch/rate/body refusal before mutation',async()=>{
  h.rate.mockResolvedValueOnce({ok:false,retryAfter:17});const response=await POST(request());expect(response.status).toBe(429);expect(response.headers.get('Retry-After')).toBe('17');expect(h.fetchCalendar).not.toHaveBeenCalled();expect(h.requests).toEqual([]);
  expect((await POST(request({icsUrl:'https://calendar.example/synthetic.ics',label:'x'.repeat(17000)}))).status).toBe(413);expect(h.fetchCalendar).not.toHaveBeenCalled();
 });
 it('preserves the SSRF guarded fetch refusal and does not fall back to direct requests',async()=>{
  h.fetchCalendar.mockResolvedValueOnce({ok:false,error:'Synthetic private address refused',status:422});expect((await POST(request())).status).toBe(422);expect(h.requests).toEqual([]);expect(h.fetchCalendar).toHaveBeenCalledWith('https://calendar.example/synthetic.ics');
 });
 it('reports a real RLS write refusal without a successful import count',async()=>{
  h.writeError=true;const response=await POST(request());expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'sync.couldNotSaveImportedCalendar'});expect(h.inserted).toEqual([]);
 });
});
