import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { parseICSSource } from '@/lib/sync/ics-source';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { expandSourceOccurrences } from '@/lib/calendar/source-occurrences';
import type { ImportedSourceComponent, ImportedSourceOverride } from '@/lib/calendar/imported-source';
import { materializeCalendarSourceSnapshot, parseCalendarSourceSnapshot, readCalendarSourceSnapshot } from '@/lib/calendar/source-snapshot';

const family = '10000000-0000-4000-8000-000000000001';
const feed = '20000000-0000-4000-8000-000000000001';
const revision = '30000000-0000-4000-8000-000000000001';
const doc = (events = ['DTSTART:20250101T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Synthetic']) => parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic snapshot//EN\r\n${events.map(body => `BEGIN:VEVENT\r\nUID:synthetic\r\n${body}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`)[0];
function group(document = doc(), feedId = feed) {
  const components: (ImportedSourceComponent | ImportedSourceOverride)[] = [...(document.master ? [document.master] : []), ...document.overrides];
  const watermarks = components.map(component => ({
    componentKey: 'recurrenceId' in component ? JSON.stringify(['override',component.recurrenceId.kind,component.recurrenceId.kind === 'zoned' ? component.recurrenceId.tzid : null,component.recurrenceId.value]) : 'master',
    versionComponent: structuredClone(component), versionRevisionId: revision,
    cancelledComponent: component.status === 'cancelled' ? structuredClone(component) : null, cancellationRevisionId: component.status === 'cancelled' ? revision : null,
  }));
  return { feedId, uid: document.uid, revisionId: revision, materializationState: 'ready', document, masterCancellationRevisionId: document.master?.status === 'cancelled' ? revision : null, watermarks };
}
function native() {
  return { id:'40000000-0000-4000-8000-000000000001',family_id:family,title:'Native',description:'',location:null,category:'general',starts_at:'2025-01-01T08:00:00.000Z',ends_at:'2025-01-01T08:30:00.000Z' as string | null,all_day:false,recurrence:'none',recurrence_until:null,assignee_id:null,feed_id:null as string | null,external_uid:null as string | null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2025-01-01T00:00:00Z',updated_at:'2025-01-01T00:00:00Z',source_recurrence:null as unknown };
}
function snapshot(groups = [group()], rows: ReturnType<typeof native>[] = []) {
  return { version:1,familyId:family,nativeRows:rows,nativeCount:rows.length,sourceGroups:groups,sourceCount:groups.length,watermarkCount:groups.reduce((sum,g) => sum + g.watermarks.length,0) };
}
function materialize(value = snapshot(), timezone = 'UTC', day = '2025-01-01', days = 3, options: { maxWork?:number;maxOccurrences?:number } = {}) {
  return materializeCalendarSourceSnapshot(value,{ familyId:family,timezone,bounds:briefingCalendarBounds(day,timezone,0,days),...options });
}

describe('complete coherent calendar source snapshots (held integration)', () => {
  it('uses the actual SDK for one family-fenced RPC and admits the complete envelope', async () => {
    const requests: {url:string;body:unknown}[] = [];
    const db = createClient('https://synthetic.invalid','synthetic-key',{ auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}, global:{fetch:async (input,init) => {
      requests.push({url:String(input),body:JSON.parse(String(init?.body))});
      return new Response(JSON.stringify(snapshot()),{status:200,headers:{'Content-Type':'application/json'}});
    }} });
    const result = await readCalendarSourceSnapshot(db,family);
    expect(result.sourceCount).toBe(1);
    expect(requests).toEqual([{url:'https://synthetic.invalid/rest/v1/rpc/calendar_read_occurrence_inputs',body:{p_family_id:family}}]);
  });
  it('does not fallback on missing-schema/authorization/transport failures', async () => {
    for (const message of ['missing function','permission denied','network down']) await expect(readCalendarSourceSnapshot({rpc:async () => ({data:null,error:{message}})},family)).rejects.toThrow(message);
  });
  it('copies input, admits SQL JSONB object key ordering and complete native/source rows', () => {
    const value = snapshot([group()],[native()]), before = JSON.stringify(value);
    const parsed = parseCalendarSourceSnapshot(value,family);
    parsed.sourceGroups[0].document.master!.title = 'Changed copy';
    expect(JSON.stringify(value)).toBe(before);
    expect(materialize(value).count).toBe(4);
  });
  it.each(['nativeCount','sourceCount','watermarkCount'] as const)('refuses a missing/capped %s collection', field => {
    const value = snapshot(); value[field]++;
    expect(() => parseCalendarSourceSnapshot(value,family)).toThrow('counts');
  });
  it.each(['version','familyId','unknown'] as const)('refuses wrong %s envelope fields', field => {
    const value: Record<string,unknown> = snapshot(); value[field] = field === 'familyId' ? feed : 7;
    expect(() => parseCalendarSourceSnapshot(value,family)).toThrow();
  });
  it('refuses foreign and duplicate native identities', () => {
    const row = native(); row.family_id = feed;
    expect(() => materialize(snapshot([], [row]))).toThrow('foreign');
    expect(() => materialize(snapshot([], [native(),native()]))).toThrow('duplicate');
  });
  it('matches the SQL independent 2000 native-series cap without cropping the window', () => {
    const rows = Array.from({length:2001},(_,index) => ({...native(),id:`40000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,recurrence:'weekly'}));
    expect(() => parseCalendarSourceSnapshot(snapshot([],rows),family)).toThrow('series count exceeds 2000');
    expect(parseCalendarSourceSnapshot(snapshot([],rows.slice(0,2000)),family).nativeCount).toBe(2000);
  });
  it('refuses rich legacy source projections and same-feed archived legacy exceptions', () => {
    const row = native(); row.source_recurrence = doc();
    expect(() => materialize(snapshot([], [row]))).toThrow('legacy source');
    row.source_recurrence = null; row.feed_id = feed as never; row.external_uid = 'synthetic\u001f20250102T090000Z' as never;
    expect(() => materialize(snapshot([group()],[row]))).toThrow('overlap');
  });
  it('refuses review-held groups, duplicate UID groups and incomplete watermark identities', () => {
    const held = group(); held.materializationState = 'needs_revision_review';
    expect(() => materialize(snapshot([held]))).toThrow('review');
    expect(() => materialize(snapshot([group(),group()]))).toThrow('duplicate');
    const incomplete = group(); incomplete.watermarks = [];
    expect(() => materialize(snapshot([incomplete]))).toThrow('incomplete');
  });
  it('refuses historical omitted overrides even when count and stored ready are plausible', () => {
    const old = group(doc(['DTSTART:20250101T090000Z\r\nRRULE:FREQ=DAILY;COUNT=3','RECURRENCE-ID:20250102T090000Z\r\nSTATUS:CANCELLED']));
    old.document.overrides = [];
    expect(() => materialize(snapshot([old]))).toThrow('omitted');
  });
  it('refuses missing or mismatched cancellation state', () => {
    const cancelled = group(doc(['DTSTART:20250101T090000Z\r\nSTATUS:CANCELLED']));
    cancelled.watermarks[0].cancelledComponent = null;
    expect(() => materialize(snapshot([cancelled]))).toThrow('cancellation');
    const live = group(); live.masterCancellationRevisionId = revision;
    expect(() => materialize(snapshot([live]))).toThrow('master cancellation');
  });
  it('admits complete master cancellation as an empty set', () => {
    expect(materialize(snapshot([group(doc(['DTSTART:20250101T090000Z\r\nSTATUS:CANCELLED']))])).count).toBe(0);
  });
  it('refuses watermark/current conflict and raw/typed conflicts without prefix', () => {
    const watermark = group(); watermark.watermarks[0].versionComponent.title = 'Wrong';
    expect(() => materialize(snapshot([watermark]))).toThrow('component conflict');
    const raw = group(); raw.document.master!.title = 'Wrong'; raw.watermarks[0].versionComponent.title = 'Wrong';
    expect(() => materialize(snapshot([raw]))).toThrow();
  });
  it('refuses raw-null provenance rather than fabricating exportable source', () => {
    const value = group(); value.document.master!.raw = null; value.watermarks[0].versionComponent.raw = null;
    expect(() => materialize(snapshot([value]))).toThrow();
  });
  it('refuses accessors without invoking them and rejects NUL/unpaired UTF16', () => {
    let reads = 0; const value = snapshot(); Object.defineProperty(value,'nativeRows',{enumerable:true,get:() => {reads++;return [];}});
    expect(() => parseCalendarSourceSnapshot(value,family)).toThrow('accessor'); expect(reads).toBe(0);
    for (const title of ['bad\u0000','bad\ud800']) { const row = native(); row.title = title; expect(() => materialize(snapshot([], [row]))).toThrow('JSONB'); }
  });
  it('preserves valid Unicode pairs', () => { const row = native(); row.title = 'Synthetic 👪'; expect(materialize(snapshot([], [row])).occurrences[0].title).toBe(row.title); });
  it('uses the SQL family watermark40k bound while retaining exact completeness', () => {
    const value = snapshot(); value.watermarkCount = 40_000;
    expect(() => parseCalendarSourceSnapshot(value,family)).toThrow('counts');
    value.watermarkCount = 40_001;
    expect(() => parseCalendarSourceSnapshot(value,family)).toThrow('collection count');
  });
  it.each(['2025-02-30T00:00:00Z','2025-01-01T24:00:00Z','2025-01-01T08:00:00','2025-01-01'])('refuses malformed or timezone-free native instant %s', starts => {
    const row = native(); row.starts_at = starts; expect(() => materialize(snapshot([], [row]))).toThrow();
  });
  it('normalizes native timestamp offsets and refuses noncivil all-day boundaries', () => {
    const row = native(); row.starts_at = '2024-12-31T19:00:00-05:00'; row.ends_at = null; row.all_day = true;
    expect(materialize(snapshot([], [row])).occurrences[0].startDate).toBe('2025-01-01');
    row.starts_at = '2025-01-01T01:00:00Z'; expect(() => materialize(snapshot([], [row]))).toThrow('UTC civil');
  });
  it('marks orphan imported identities read-only and preserves native missing-end busy overlap', () => {
    const row = native(); row.external_uid = 'orphan' as never; row.starts_at = '2024-12-31T23:30:00Z'; row.ends_at = null;
    const result = materialize(snapshot([], [row]),'UTC','2025-01-01',1);
    expect(result.count).toBe(1); expect(result.occurrences[0]).toMatchObject({readOnly:true,ends_at:null,actualEndsAt:'2025-01-01T00:30:00.000Z'});
  });
  it('rejects cancellation-pointer mismatch and uncounted decorated arrays', () => {
    const cancelled = group(doc(['DTSTART:20250101T090000Z\r\nSTATUS:CANCELLED'])); cancelled.masterCancellationRevisionId = null;
    expect(() => materialize(snapshot([cancelled]))).toThrow('master cancellation');
    const value = snapshot(); const rows: unknown[] = new Array(1); Object.assign(rows,{hidden:native()});
    Object.assign(value,{nativeRows:rows,nativeCount:1}); expect(() => parseCalendarSourceSnapshot(value,family)).toThrow('array');
  });
  it('reads moved-in overrides and PERIOD RDATE regardless original master date', () => {
    const value = snapshot([group(doc(['DTSTART:20260101T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=2\r\nRDATE;VALUE=PERIOD:20250102T100000Z/PT3H','RECURRENCE-ID:20260101T090000Z\r\nDTSTART:20250101T100000Z\r\nDURATION:PT2H']))]);
    const result = materialize(value);
    expect(result.count).toBe(2);
    expect(result.occurrences[0].reference).toMatchObject({kind:'source',original:{kind:'utc',value:'20260101T090000Z'}});
    expect(result.occurrences[1].ends_at).toBe('2025-01-02T13:00:00.000Z');
  });
  it('namespaces identical UID/original identities by feed, preserving read-only reference', () => {
    const result = materialize(snapshot([group(),group(doc(), '20000000-0000-4000-8000-000000000002')]));
    expect(result.count).toBe(6); expect(new Set(result.occurrences.map(c => c.occurrenceKey)).size).toBe(6);
    expect(result.occurrences.every(c => c.readOnly && c.reference.kind === 'source' && !('eventId' in c.reference))).toBe(true);
  });
  it('preserves DATE civil display separately from Tokyo actual busy instants', () => {
    const result = materialize(snapshot([group(doc(['DTSTART;VALUE=DATE:20250101\r\nDURATION:P2D']))]),'Asia/Tokyo');
    expect(result.occurrences[0]).toMatchObject({startDate:'2025-01-01',endDate:'2025-01-03',starts_at:'2025-01-01T00:00:00.000Z',actualStartsAt:'2024-12-31T15:00:00.000Z',actualEndsAt:'2025-01-02T15:00:00.000Z'});
  });
  it('retains a civil DATE on Apia skipped Dec30 even when timed window is empty', () => {
    const result = materialize(snapshot([group(doc(['DTSTART;VALUE=DATE:20111230']))]),'Pacific/Apia','2011-12-30',1);
    expect(result.count).toBe(1); expect(result.occurrences[0]).toMatchObject({startDate:'2011-12-30',endDate:'2011-12-31',actualStartsAt:'2011-12-30T10:00:00.000Z',actualEndsAt:'2011-12-30T10:00:00.000Z'});
  });
  it('handles native overlap and recurring identity with the actual native engine', () => {
    const row = native(); row.recurrence = 'daily'; row.starts_at = '2024-12-31T23:00:00Z'; row.ends_at = '2025-01-01T02:00:00Z';
    const result = materialize(snapshot([], [row]),'UTC','2025-01-01',1);
    expect(result.count).toBe(2); expect(result.occurrences.every(c => c.reference.kind === 'native')).toBe(true);
  });
  it('refuses a family output overflow rather than returning one healthy UID prefix', () => {
    expect(() => materialize(snapshot([group(),group(doc(),'20000000-0000-4000-8000-000000000002')]),'UTC','2025-01-01',3,{maxOccurrences:4})).toThrow('family occurrence');
  });
  it('charges actual per-UID engine work to one enclosing family budget', () => {
    let work = 0;
    expandSourceOccurrences(doc(),{from:Date.parse('2025-01-01'),to:Date.parse('2025-01-04'),dateTimezone:'UTC',consumeWork:amount => { work += amount; }});
    // Materializer does two complete expansions to preserve mixed typed clocks.
    const budget = work * 2 + 20;
    expect(materialize(snapshot(),'UTC','2025-01-01',3,{maxWork:budget}).count).toBe(3);
    expect(() => materialize(snapshot([group(),group(doc(),'20000000-0000-4000-8000-000000000002')]),'UTC','2025-01-01',3,{maxWork:budget})).toThrow('family work');
  });
});
