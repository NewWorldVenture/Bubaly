import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import type { ImportedSourceComponent, ImportedSourceOverride } from '@/lib/calendar/imported-source';
import { parseICSSource } from '@/lib/sync/ics-source';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
const h = vi.hoisted(() => ({enabled:false}));
vi.mock('@/lib/calendar/source-capability', () => ({get CALENDAR_SOURCE_ARCHIVE_ENABLED() {return h.enabled;}}));
import { readDisplayCalendarOccurrences } from '@/lib/calendar/display-occurrences';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
const family = '10000000-0000-4000-8000-000000000001', feed = '20000000-0000-4000-8000-000000000001', revision = '30000000-0000-4000-8000-000000000001';
function document(events = ['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Synthetic source']) {
  return parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic display//EN\r\n${events.map(body => `BEGIN:VEVENT\r\nUID:synthetic\r\n${body}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`)[0];
}
function group(doc = document(), feedId = feed) {
  const components: (ImportedSourceComponent | ImportedSourceOverride)[] = [...(doc.master ? [doc.master] : []),...doc.overrides];
  return {feedId,uid:doc.uid,revisionId:revision,materializationState:'ready',document:doc,masterCancellationRevisionId:doc.master?.status === 'cancelled' ? revision : null,watermarks:components.map(component => ({
    componentKey:'recurrenceId' in component ? JSON.stringify(['override',component.recurrenceId.kind,component.recurrenceId.kind === 'zoned' ? component.recurrenceId.tzid : null,component.recurrenceId.value]) : 'master',versionComponent:structuredClone(component),versionRevisionId:revision,cancelledComponent:component.status === 'cancelled' ? structuredClone(component) : null,cancellationRevisionId:component.status === 'cancelled' ? revision : null,
  }))};
}
function native(index = 1): Tables<'calendar_events'> & {source_recurrence:null} {
  return {id:`40000000-0000-4000-8000-${String(index).padStart(12,'0')}`,family_id:family,title:`Native${index}`,description:null,location:null,category:'school',starts_at:`2026-10-08T0${index}:00:00.000Z`,ends_at:null,all_day:false,recurrence:'none',recurrence_until:null,assignee_id:null,feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',source_recurrence:null};
}
function snapshot(groups = [group()], nativeRows = [native()]) {return {version:1,familyId:family,nativeRows,nativeCount:nativeRows.length,sourceGroups:groups,sourceCount:groups.length,watermarkCount:groups.reduce((sum,g) => sum+g.watermarks.length,0)};}
function sdk(value: unknown = snapshot(), status = 200) {
  const requests: URL[] = [];
  const db = createClient<Database>('https://synthetic-display.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async (input,init) => {
    const url = new URL(String(input));requests.push(url);
    if (url.pathname.includes('/rpc/')) {
      expect(JSON.parse(String(init?.body))).toEqual({p_family_id:family});
      return Response.json(value,{status});
    }
    expect(url.searchParams.get('family_id')).toBe(`eq.${family}`);
    expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
    const offset = Number(url.searchParams.get('offset') ?? 0), rows = url.searchParams.has('recurrence') ? [] : [native(1),native(2),native(3)].slice(offset,offset+2);
    return Response.json(rows,{headers:{'content-range':`${offset}-${offset+rows.length-1}/${url.searchParams.has('recurrence') ? 0 : 3}`}});
  }}});
  return {db,requests};
}
const bounds = briefingCalendarBounds('2026-10-08','UTC',0,3);
beforeEach(() => {h.enabled = false;});
describe('actual SDK source-aware display consumer', () => {
  it('default-disabled retains complete capped native reads and real DB references', async () => {
    const {db,requests} = sdk();const result = await readDisplayCalendarOccurrences(db,family,bounds,'UTC');
    expect(result.error).toBeNull();expect(result.count).toBe(3);expect(requests.some(url => url.pathname.includes('/rpc/'))).toBe(false);
    expect(result.data?.every(row => row.kind === 'native' && row.event.id === row.reference.eventId)).toBe(true);
    expect(requests.filter(url => !url.searchParams.has('recurrence')).map(url => url.searchParams.get('offset') ?? '0')).toEqual(['0','2']);
  });
  it('enabled generic unmigrated native reader refuses before any HTTP query', async () => {
    h.enabled = true;const {db,requests} = sdk();const result = await readCalendarOccurrences(db,family,bounds,'UTC');
    expect(result.data).toBeNull();expect(result.count).toBeNull();expect(result.error).not.toBeNull();expect(requests).toHaveLength(0);
  });
  it.each([false,true])('rejects a zero display limit consistently with gate=%s',async enabled=>{
    h.enabled=enabled;const {db,requests}=sdk();const result=await readDisplayCalendarOccurrences(db,family,bounds,'UTC',{limit:0});expect(result.data).toBeNull();expect(requests).toHaveLength(0);
  });
  it('enabled display reads one coherent RPC and retains source identity without a DB ID', async () => {
    h.enabled = true;const {db,requests} = sdk();const result = await readDisplayCalendarOccurrences(db,family,bounds,'UTC');
    expect(result.count).toBe(4);expect(requests).toHaveLength(1);expect(requests[0].pathname).toContain('/rpc/calendar_read_occurrence_inputs');
    const source = result.data?.find(row => row.kind === 'source');expect(source).toMatchObject({readOnly:true,reference:{kind:'source',feedId:feed,uid:'synthetic',original:{kind:'utc',value:'20261008T090000Z'}}});
    expect(source).not.toHaveProperty('id');expect(source).not.toHaveProperty('eventId');expect(source).not.toHaveProperty('event');
    const nativeRow = result.data?.find(row => row.kind === 'native');expect(nativeRow?.category).toBe('school');expect(nativeRow?.kind === 'native' && nativeRow.event.id).toBe(native().id);
  });
  it.each(['missing-schema','permission','review','raw-conflict','counts','legacy'])('enabled %s fails the entire display read without native fallback', async fault => {
    h.enabled = true;const value = snapshot();let status = 200;let payload: unknown = value;
    if (fault === 'missing-schema' || fault === 'permission') {status = 400;payload = {code:fault === 'permission' ? '42501' : 'PGRST202',message:'Private provider detail'};}
    if (fault === 'review') value.sourceGroups[0].materializationState = 'needs_revision_review';
    if (fault === 'raw-conflict') {value.sourceGroups[0].document.master!.title = 'Wrong';value.sourceGroups[0].watermarks[0].versionComponent.title = 'Wrong';}
    if (fault === 'counts') value.nativeCount++;
    if (fault === 'legacy') Object.assign(value.nativeRows[0],{source_recurrence:document()});
    const {db,requests} = sdk(payload,status);const result = await readDisplayCalendarOccurrences(db,family,bounds,'UTC');
    expect(result.data).toBeNull();expect(result.count).toBeNull();expect(result.error?.message).not.toContain('Private');expect(requests).toHaveLength(1);
  });
  it('keeps complete count before a display limit and namespaces same UID across feeds', async () => {
    h.enabled = true;const {db} = sdk(snapshot([group(),group(document(),'20000000-0000-4000-8000-000000000002')],[]));
    const full = await readDisplayCalendarOccurrences(db,family,bounds,'UTC');expect(full.count).toBe(6);expect(new Set(full.data?.map(row => row.occurrenceKey)).size).toBe(6);
    const limited = await readDisplayCalendarOccurrences(db,family,bounds,'UTC',{limit:2});expect(limited.count).toBe(6);expect(limited.data).toHaveLength(2);
  });
  it('retains moved-in original references and concrete DATE civil/actual boundaries', async () => {
    h.enabled = true;const doc = document(['DTSTART;VALUE=DATE:20270101\r\nRRULE:FREQ=DAILY;COUNT=2','RECURRENCE-ID;VALUE=DATE:20270101\r\nDTSTART;VALUE=DATE:20261008\r\nDURATION:P2D']);
    const {db} = sdk(snapshot([group(doc)],[]));const result = await readDisplayCalendarOccurrences(db,family,briefingCalendarBounds('2026-10-08','Asia/Tokyo',0,3),'Asia/Tokyo');
    expect(result.count).toBe(1);expect(result.data?.[0]).toMatchObject({startDate:'2026-10-08',endDate:'2026-10-10',starts_at:'2026-10-08T00:00:00.000Z',actualStartsAt:'2026-10-07T15:00:00.000Z',reference:{original:{kind:'date',value:'20270101'}}});
  });
  it('applies start-only vs overlap after complete materialization', async () => {
    h.enabled = true;const {db} = sdk(snapshot([group(document(['DTSTART:20261007T230000Z\r\nDURATION:PT3H']))],[]));
    expect((await readDisplayCalendarOccurrences(db,family,bounds,'UTC')).count).toBe(0);
    expect((await readDisplayCalendarOccurrences(db,family,bounds,'UTC',{overlap:true})).count).toBe(1);
  });
  it('keeps source title/category nullable and marks legacy orphan identities read-only', async () => {
    h.enabled = true;const row = native();row.external_uid = 'legacy';const {db} = sdk(snapshot([group(document(['DTSTART:20261008T090000Z']))],[row]));
    const result = await readDisplayCalendarOccurrences(db,family,bounds,'UTC');expect(result.data?.find(row => row.kind === 'source')).toMatchObject({title:null,category:null,assignee_id:null});
    expect(result.data?.find(row => row.kind === 'native')?.readOnly).toBe(true);
  });
});
