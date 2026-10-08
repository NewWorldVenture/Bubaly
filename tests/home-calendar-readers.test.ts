import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { createInMemorySupabase, orPredicate } from './helpers/in-memory-supabase';
import { parseICSSource } from '@/lib/sync/ics-source';

const mocks = vi.hoisted(() => ({ server: vi.fn(), today: vi.fn(), upcoming: vi.fn(), conflicts: vi.fn(), needs: vi.fn(), brief: vi.fn(), locale: 'en-US' as LocaleCode, source: false, snapshot: null as unknown }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return mocks.source; } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => false }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/autopilot/engine', () => ({ successProbability: () => 0 }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: async () => ({ locale: { code: mocks.locale }, messages: getMessages(mocks.locale) }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useFamilyTimeZone: () => undefined, useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(mocks.locale), key, params) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));
vi.mock('@/components/concierge/ask-bubaly', () => ({ AskBubaly: () => null }));
vi.mock('@/components/concierge/working-on', () => ({ WorkingOn: () => null }));
vi.mock('@/components/concierge/completed-by-bubaly', () => ({ CompletedByBubaly: () => null }));
vi.mock('@/components/dashboard/quick-actions', () => ({ DashboardQuickActions: () => null }));
vi.mock('@/components/dashboard/insight-hero', () => ({ InsightHero: ({ insight }: { insight: { title: string } }) => React.createElement('aside', null, insight.title) }));
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
vi.mock('@/components/concierge/needs-you-actions', () => ({ FactSuggestionActions: () => null, InboxMessageActions: () => null }));
vi.mock('@/lib/home/today', async original => {
  const actual = await original<typeof import('@/lib/home/today')>();
  return { ...actual, buildToday: (...args: Parameters<typeof actual.buildToday>) => { mocks.today(...args); return actual.buildToday(...args); } };
});
vi.mock('@/lib/dashboard/upcoming', async original => {
  const actual = await original<typeof import('@/lib/dashboard/upcoming')>();
  return { ...actual, mergeUpcoming: (...args: Parameters<typeof actual.mergeUpcoming>) => { mocks.upcoming(...args); return actual.mergeUpcoming(...args); } };
});
vi.mock('@/lib/home/conflicts', async original => {
  const actual = await original<typeof import('@/lib/home/conflicts')>();
  return { ...actual, detectConflicts: (...args: Parameters<typeof actual.detectConflicts>) => { mocks.conflicts(...args); return actual.detectConflicts(...args); } };
});
vi.mock('@/lib/home/home-brief', async original => {
  const actual = await original<typeof import('@/lib/home/home-brief')>();
  return { ...actual, buildHomeBrief: (...args: Parameters<typeof actual.buildHomeBrief>) => { mocks.brief(...args); return actual.buildHomeBrief(...args); } };
});
vi.mock('@/lib/home/needs-build',async original=>{
  const actual=await original<typeof import('@/lib/home/needs-build')>();
  return {...actual,buildHomeNeeds:(...args:Parameters<typeof actual.buildHomeNeeds>)=>{mocks.needs(...args);return actual.buildHomeNeeds(...args);}};
});
import { AiHomeDashboard } from '@/components/dashboard/ai-home-dashboard';

type DB = SupabaseClient<Database>;
let db = createInMemorySupabase<DB>();
function row(title: string, starts_at: string, all_day = false, assignee_id: string | null = 'parent', family_id = 'family', ends_at: string | null = null) {
  return { id: title, title, starts_at, ends_at, all_day, assignee_id, family_id, location: 'Literal {location}' };
}
async function home(zone = 'UTC', role = 'parent', familyId = 'family') {
  const ctx = { user: { id: 'user', email: 'alex@example.test' }, active: { familyId, role, member: { id: 'parent', display_name: 'Alex' }, family: { name: 'Family', timezone: zone } } } as UserContext;
  return renderToStaticMarkup(await AiHomeDashboard({ ctx }));
}
function failCalendar(read: number, rejection: boolean) {
  let n = 0;
  const from = db.from.bind(db);
  return vi.spyOn(db, 'from').mockImplementation(table => {
    const query = from(table);
    return table !== 'calendar_events' || ++n !== (read - 1) * 2 + 1 ? query : new Proxy(query, { get: (target, key, receiver) => key === 'then'
      ? (resolve: (value: unknown) => void, reject: (cause: unknown) => void) => rejection
        ? reject(new Error('Internal calendar transport detail')) : resolve({ data: [], error: { message: 'Internal calendar query detail' } })
      : Reflect.get(target, key, receiver) });
  });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T16:00:00Z')); mocks.locale = 'en-US'; mocks.source = false; mocks.snapshot = null;
  db = createInMemorySupabase<DB>(); mocks.server.mockResolvedValue(db);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function sdkCalendar(rows: Record<string, unknown>[], fault = '', familyId = 'family') {
  const requests: URL[] = [];
  const client = createClient<Database>('https://synthetic-dashboard.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url);
      if(url.pathname.includes('/rpc/calendar_read_occurrence_inputs')) {
        expect(JSON.parse(String(init?.body))).toEqual({p_family_id:familyId});
        return Response.json(mocks.snapshot);
      }
      if(!url.pathname.endsWith('/calendar_events')) return Response.json([], {headers:{'content-range':'*/0'}});
      expect(url.searchParams.get('family_id')).toBe(`eq.${familyId}`);
      expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      let selected=rows.filter(orPredicate(`family_id.${url.searchParams.get('family_id')}`));
      for(const expression of url.searchParams.getAll('or')) selected=selected.filter(orPredicate(expression.slice(1,-1)));
      for(const expression of url.searchParams.getAll('recurrence')) selected=selected.filter(orPredicate(`recurrence.${expression}`));
      for(const expression of url.searchParams.getAll('starts_at')) selected=selected.filter(orPredicate(`starts_at.${expression}`));
      selected.sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at))||String(a.id).localeCompare(String(b.id)));
      const offset=Number(url.searchParams.get('offset')??0),limit=Math.min(2,Number(url.searchParams.get('limit')??1000));
      let page=selected.slice(offset,offset+limit); const count=selected.length+(fault==='drift'&&offset>0?1:0);
      if(fault==='duplicate'&&offset>0)page=selected.slice(0,limit);
      if(fault==='foreign')page=page.map(event=>({...event,family_id:'other-family'}));
      if(fault==='interval')page=page.map(event=>({...event,ends_at:'invalid'}));
      if(fault==='midnight')vi.setSystemTime(new Date('2026-09-10T01:00:00Z'));
      return Response.json(page,{headers:fault==='count'?{}:{'content-range':page.length?`${offset}-${offset+page.length-1}/${count}`:`*/${count}`}});
    } },
  });
  mocks.server.mockResolvedValue(client);return requests;
}
function sourceEnvelope(lines:string) {
  const familyId='10000000-0000-4000-8000-000000000001',revisionId='30000000-0000-4000-8000-000000000001';
  const document=parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic Dashboard//EN\r\nBEGIN:VEVENT\r\nUID:source-home\r\nSUMMARY:Original source annotation\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
  return {version:1,familyId,nativeRows:[],nativeCount:0,sourceCount:1,watermarkCount:1,sourceGroups:[{
    feedId:'20000000-0000-4000-8000-000000000001',uid:document.uid,revisionId,materializationState:'ready',document,
    masterCancellationRevisionId:null,watermarks:[{componentKey:'master',versionComponent:structuredClone(document.master),versionRevisionId:revisionId,cancelledComponent:null,cancellationRevisionId:null}],
  }]};
}

describe('actual Home calendar reads and rendered read availability', () => {
  it('recurring native conflicts retain distinct original occurrence identities for each weekly advisory',async()=>{
    db.seed('calendar_events',[
      {...row('Weekly A','2026-06-03T18:00:00.000Z',false,'parent','family','2026-06-03T19:00:00.000Z'),recurrence:'weekly',recurrence_until:null},
      {...row('Weekly B','2026-06-03T18:30:00.000Z',false,'parent','family','2026-06-03T19:30:00.000Z'),recurrence:'weekly',recurrence_until:null},
    ]);
    await home();const conflicts=mocks.needs.mock.calls[0][0].conflicts as {id:string}[];
    expect(conflicts).toHaveLength(3);expect(new Set(conflicts.map(conflict=>conflict.id)).size).toBe(3);
  });
  it('actual SDK cap-two read reaches late rows and clips ongoing travel before five-row presentation caps',async()=>{
    const rows=[...Array.from({length:6},(_,i)=>({...row(`Other member${i}`,'2026-09-09T07:00:00.000Z',false,'other','family','2026-09-09T08:00:00.000Z'),recurrence:'none'})),
      {...row('Late visible trip','2026-09-08T23:00:00.000Z',false,'parent','family','2026-09-11T19:00:00.000Z'),recurrence:'none'},
      {...row('Late meeting','2026-09-10T18:00:00.000Z',false,'parent','family','2026-09-10T19:00:00.000Z'),recurrence:'none'},
      {...row('Foreign private title','2026-09-09T18:00:00.000Z',false,'parent','other-family','2026-09-09T19:00:00.000Z'),recurrence:'none'},
      {...row('Exact outside end','2026-09-17T00:00:00.000Z',false,'parent','family','2026-09-17T01:00:00.000Z'),recurrence:'none'}];
    const requests=sdkCalendar(rows),html=await home();
    expect(html).toContain('Late visible trip');expect(html).not.toContain('Foreign private title');expect(html).not.toContain('Other member0');
    expect(mocks.upcoming.mock.calls[0][0].map((e:{title:string})=>e.title)).toEqual(['Late visible trip','Late meeting']);
    expect(mocks.conflicts.mock.calls[0][0].find((e:{title:string})=>e.title==='Late visible trip').conflictEndsAt).toBe('2026-09-11T19:00:00.000Z');
    expect(html).toContain('2 events overlap');
    expect(requests.some(url=>Number(url.searchParams.get('offset'))>=6)).toBe(true);
  });
  it.each(['count','drift','duplicate','foreign','interval'])('actual SDK %s uncertainty refuses all calendar claims and outcome advice',async fault=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const rows=['a','b','c'].map(id=>({...row(id,'2026-09-09T18:00:00.000Z',false,'parent','family','2026-09-09T19:00:00.000Z'),recurrence:'none'}));
    sdkCalendar(rows,fault);const html=await home();
    expect(html.match(/<p role="status"/g)).toHaveLength(fault==='count'?3:2);
    // The upcoming set is genuinely empty: row-dependent faults cannot occur
    // there, while even an empty read still requires an exact count.
    expect(html).not.toContain(translate(getMessages('en-US'),'aiHomeDashboard.aClearDayNothingScheduledAnd'));
    expect(mocks.brief).not.toHaveBeenCalled();expect(mocks.today.mock.calls[0][0].events).toEqual([]);
  });
  it('one server day snapshot survives a midnight crossed during asynchronous calendar reads',async()=>{
    sdkCalendar([{...row('Snapshot day event','2026-09-09T18:00:00.000Z',false,'parent','family','2026-09-09T19:00:00.000Z'),recurrence:'none'}],'midnight');
    const html=await home();expect(html).toContain('Snapshot day event');expect(mocks.today.mock.calls[0][0].todayKey).toBe('2026-09-09');
  });
  it('Tokyo upcoming DATE annotation sorts at family midnight while keeping its civil badge date',async()=>{
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    db.seed('calendar_events',[row('Tomorrow civil holiday','2026-09-10T00:00:00.000Z',true,null),row('Tomorrow early meeting','2026-09-09T16:00:00.000Z',false,null,'family','2026-09-09T17:00:00.000Z')]);
    const html=await home('Asia/Tokyo');expect(at(html,'Tomorrow civil holiday')).toBeLessThan(at(html,'Tomorrow early meeting'));
    expect(html).toContain(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date('2026-09-10T12:00:00Z')));
  });
  it.each([
    ['DATE','DTSTART;VALUE=DATE:20260908\r\nDTEND;VALUE=DATE:20260912'],
    ['overnight','DTSTART:20260908T230000Z\r\nDTEND:20260911T190000Z'],
    ['older weekly master','DTSTART:20260603T180000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=20'],
    ['implicit point','DTSTART:20260909T180000Z'],
  ])('enabled actual SDK source %s retains original references without native IDs',async(_kind,lines)=>{
    mocks.source=true;mocks.snapshot=sourceEnvelope(lines);const familyId=(mocks.snapshot as ReturnType<typeof sourceEnvelope>).familyId;
    const requests=sdkCalendar([], '', familyId),html=await home('America/New_York','parent',familyId);
    expect(html).toContain('Original source annotation');
    const event=mocks.today.mock.calls[0][0].events[0];expect(event.kind).toBe('source');expect(event.reference.kind).toBe('source');expect(event).not.toHaveProperty('id');
    const {mergeUpcoming}=await vi.importActual<typeof import('@/lib/dashboard/upcoming')>('@/lib/dashboard/upcoming');
    expect(mergeUpcoming([event],[])[0]).toMatchObject({id:null,reference:event.reference,occurrenceKey:event.occurrenceKey,key:`event:${event.occurrenceKey}`});
    expect(mocks.conflicts.mock.calls[0][0]).toEqual([]);expect(requests.filter(url=>url.pathname.endsWith('/calendar_events'))).toEqual([]);
    expect(requests.filter(url=>url.pathname.includes('/rpc/'))).toHaveLength(3);
  });
  it.each(['missing','review','short'])('enabled source %s refuses without native fallback or a quiet outcome',async kind=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});mocks.source=true;
    const snapshot=sourceEnvelope('DTSTART:20260909T180000Z\r\nDURATION:PT1H');
    if(kind==='review')snapshot.sourceGroups[0].materializationState='revision_review';
    if(kind==='short')snapshot.sourceCount=2;
    mocks.snapshot=kind==='missing'?{code:'PGRST202',message:'Synthetic unavailable RPC'}:snapshot;
    const requests=sdkCalendar([],'',snapshot.familyId),html=await home('UTC','parent',snapshot.familyId);
    expect(html.match(/<p role="status"/g)).toHaveLength(3);expect(mocks.brief).not.toHaveBeenCalled();
    expect(requests.filter(url=>url.pathname.endsWith('/calendar_events'))).toEqual([]);
  });
  it('an ongoing trip beginning before today stays in Today and every relevant future window', async () => {
    db.seed('calendar_events', [row('Ongoing travel', '2026-09-07T18:00:00.000Z', false, 'parent', 'family', '2026-09-11T19:00:00.000Z')]);
    const html = await home();
    expect(html).toContain('Ongoing travel');
    expect(mocks.today.mock.calls[0][0].events).toHaveLength(1);
    expect(mocks.upcoming.mock.calls[0][0]).toHaveLength(1);
  });
  it('an older weekly master appears this week and late assigned commitments are not capped at200', async () => {
    db.seed('calendar_events', [{ ...row('Weekly lesson', '2026-06-03T18:00:00.000Z', false, 'parent', 'family', '2026-06-03T19:00:00.000Z'), recurrence: 'weekly', recurrence_until: null },
      ...Array.from({ length: 201 }, (_, index) => row(`Morning${index}`, '2026-09-09T08:00:00.000Z', false, 'parent', 'family', '2026-09-09T08:01:00.000Z')),
      row('Late commitment', '2026-09-10T18:00:00.000Z', false, 'parent', 'family', '2026-09-10T19:00:00.000Z')]);
    await home();
    expect(mocks.conflicts.mock.calls[0][0].some((event: { title: string }) => event.title === 'Weekly lesson')).toBe(true);
    expect(mocks.conflicts.mock.calls[0][0].some((event: { title: string }) => event.title === 'Late commitment')).toBe(true);
  });
  it.each(['America/New_York', 'Asia/Tokyo', 'UTC'])('%s retains today and tomorrow date-only events, raw data and visibility', async zone => {
    const rows = [row('Today holiday {title}', '2026-09-09T00:00:00.000Z', true), row('Tomorrow holiday', '2026-09-10T00:00:00.000Z', true),
      row('Shared meeting', '2026-09-09T12:00:00.000Z', false, null), row('Other member', '2026-09-09T13:00:00.000Z', false, 'other'),
      row('Other family', '2026-09-09T12:00:00.000Z', false, 'parent', 'other')];
    if (zone === 'Asia/Tokyo') vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    db.seed('calendar_events', rows); const before = structuredClone(db.table('calendar_events'));
    const html = await home(zone);
    expect(mocks.today.mock.calls[0][0].events.map((e: { title: string }) => e.title)).toEqual(['Today holiday {title}', 'Shared meeting']);
    expect(mocks.upcoming.mock.calls[0][0].map((e: { title: string }) => e.title)).toEqual(['Tomorrow holiday']);
    expect(html).toContain('Today holiday {title}'); expect(html).toContain('Tomorrow holiday'); expect(html).not.toContain('Other family'); expect(html).not.toContain('Other member');
    expect(db.table('calendar_events')).toEqual(before); expect(db.log.some(entry => entry.table === 'home_briefs')).toBe(false);
  });

  it.each([['America/Santiago', '2026-09-06T15:00:00Z', '2026-09-06T03:30:00.000Z'], ['America/Havana', '2026-03-08T15:00:00Z', '2026-03-08T04:30:00.000Z']])('%s excludes the previous local day at a midnight gap', async (zone, now, previous) => {
    vi.setSystemTime(new Date(now)); db.seed('calendar_events', [row('Previous local date', previous, false, 'parent', 'family', new Date(Date.parse(previous) + 60_000).toISOString())]);
    await home(zone); expect(mocks.today.mock.calls[0][0].events).toEqual([]); expect(mocks.conflicts.mock.calls[0][0]).toEqual([]);
  });

  it.each([[1, false], [2, false], [3, false], [1, true], [2, true], [3, true]])('calendar read %i failure/rejection %s cannot become a calendar all-clear', async (read, rejection) => {
    const failure = failCalendar(read, rejection); const html = await home();
    expect(html).toContain('temporarily unavailable');
    expect(html).not.toContain('Internal calendar'); expect(mocks.brief).not.toHaveBeenCalled();
    if (read === 1) expect(html).not.toContain(translate(getMessages('en-US'), 'aiHomeDashboard.aClearDayNothingScheduledAnd'));
    if (read === 3) expect(html).not.toContain(translate(getMessages('en-US'), 'needsAttention.nothingNeedsYouRightNowBubaly'));
    failure.mockRestore();
    db.seed('calendar_events', [row('Healthy today event', '2026-09-09T18:00:00.000Z'), row('Healthy upcoming event', '2026-09-10T18:00:00.000Z')]);
    db.seed('todo_items', [{ id: 'task', family_id: 'family', title: 'Healthy due task', due_date: '2026-09-09', is_done: false }]);
    db.seed('family_reminders', [{ id: 'reminder', family_id: 'family', title: 'Healthy reminder', remind_at: '2026-09-09T19:00:00.000Z', status: 'active', member_id: 'parent' },
      { id: 'upcoming', family_id: 'family', title: 'Healthy upcoming reminder', remind_at: '2026-09-10T19:00:00.000Z', status: 'active', member_id: 'parent' }]);
    const secondFailure = failCalendar(read, rejection); const degraded = await home();
    const notice = degraded.match(/<p role="status"[^>]*>(.*?)<\/p>/g) ?? [];
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(translate(getMessages('en-US'), ['homeCalendar.todayUnavailable', 'homeCalendar.upcomingUnavailable', 'homeCalendar.conflictsUnavailable'][read - 1]));
    expect(notice[0]).toContain('href="/dashboard"'); expect(notice[0]).toContain('Try again');
    expect(degraded).toContain('Healthy due task'); expect(degraded).toContain('Healthy reminder'); expect(degraded).toContain('Healthy upcoming reminder');
    expect(degraded.includes('Healthy today event')).toBe(read !== 1); expect(degraded.includes('Healthy upcoming event')).toBe(read !== 2);
    secondFailure.mockRestore(); const recovered = await home();
    expect(recovered).not.toContain('temporarily unavailable'); expect(recovered).toContain('Healthy today event'); expect(recovered).toContain('Healthy upcoming event');
  });

  it('keeps healthy empty arrays successful', async () => {
    const html = await home(); expect(html).toContain(translate(getMessages('en-US'), 'aiHomeDashboard.aClearDayNothingScheduledAnd'));
    expect(html).not.toContain('temporarily unavailable'); expect(mocks.brief).toHaveBeenCalledOnce();
  });

  it.each([
    ['2026-03-07T17:00:00Z', '2026-03-14', '2026-03-15T03:59:59.999Z', '2026-03-15T04:00:00.000Z', '2026-03-21', '2026-03-22T03:59:59.999Z', '2026-03-22T04:00:00.000Z'],
    ['2026-10-31T16:00:00Z', '2026-11-07', '2026-11-08T04:59:59.999Z', '2026-11-08T05:00:00.000Z', '2026-11-14', '2026-11-15T04:59:59.999Z', '2026-11-15T05:00:00.000Z'],
  ])('retains complete +7/+14 terminal dates and excludes the next midnight across DST at %s', async (now, weekDay, weekLast, weekEnd, fortnightDay, fortnightLast, fortnightEnd) => {
    vi.setSystemTime(new Date(now)); db.seed('calendar_events', [row('Last week holiday', `${weekDay}T00:00:00.000Z`, true), row('Last week timed', weekLast),
      row('Outside week', weekEnd), row('Last fortnight holiday', `${fortnightDay}T00:00:00.000Z`, true), row('Last fortnight timed', fortnightLast), row('Outside fortnight', fortnightEnd)]);
    await home('America/New_York');
    expect(mocks.upcoming.mock.calls[0][0].map((e: { title: string }) => e.title)).toEqual(['Last week holiday', 'Last week timed']);
    expect(mocks.conflicts.mock.calls[0][0].map((e: { title: string }) => e.title)).toEqual(['Last week holiday', 'Last week timed', 'Outside week', 'Last fortnight holiday', 'Last fortnight timed']);
  });

  it('applies typed date and visibility filters before both five-row limits', async () => {
    db.seed('calendar_events', [
      ...Array.from({ length: 6 }, (_, i) => row(`Previous${i}`, `2026-09-08T0${i}:00:00.000Z`, true)),
      ...Array.from({ length: 6 }, (_, i) => row(`Other family${i}`, `2026-09-09T0${i}:00:00.000Z`, true, 'parent', 'other')),
      row('Today holiday', '2026-09-09T00:00:00.000Z', true),
      ...Array.from({ length: 6 }, (_, i) => row(`Today${i}`, `2026-09-09T1${i}:00:00.000Z`)),
      row('Tomorrow holiday', '2026-09-10T00:00:00.000Z', true),
      ...Array.from({ length: 6 }, (_, i) => row(`Tomorrow${i}`, `2026-09-10T1${i}:00:00.000Z`, false, null)),
    ]);
    await home('America/New_York');
    expect(mocks.today.mock.calls[0][0].events.map((e: { title: string }) => e.title)).toEqual(['Today holiday', 'Today0', 'Today1', 'Today2', 'Today3']);
    expect(mocks.upcoming.mock.calls[0][0].map((e: { title: string }) => e.title)).toEqual(['Tomorrow holiday', 'Tomorrow0', 'Tomorrow1', 'Tomorrow2', 'Tomorrow3', 'Tomorrow4', 'Tomorrow5']);
  });

  it('reads every assigned occurrence before conflict detection, retaining assigned-only order', async () => {
    db.seed('calendar_events', [
      ...Array.from({ length: 205 }, (_, i) => row(`Prior${i}`, '2026-09-08T00:00:00.000Z', true)),
      row('Other family', '2026-09-09T00:00:00.000Z', true, 'parent', 'other'),
      row('Shared holiday', '2026-09-09T00:00:00.000Z', true, null),
      ...Array.from({ length: 205 }, (_, i) => row(`Assigned${i}`, new Date(Date.parse('2026-09-09T00:00:00Z') + i * 1000).toISOString(), true)),
    ]);
    await home('America/New_York');
    const selected = mocks.conflicts.mock.calls[0][0] as { title: string }[];
    expect(selected).toHaveLength(205); expect(selected[0].title).toBe('Assigned0'); expect(selected[204].title).toBe('Assigned204');
  });

  it.each(['parent', 'child', 'guest'])('%s retains conflict visibility and same-family member-or-shared schedule permissions', async role => {
    db.seed('family_members', [{ id: 'parent', family_id: 'family', display_name: 'Alex', is_active: true }, { id: 'other', family_id: 'family', display_name: 'Other person', is_active: true }]);
    db.seed('calendar_events', [row('Mine A', '2026-09-09T12:00:00.000Z', false, 'parent', 'family', '2026-09-09T13:00:00.000Z'), row('Mine B', '2026-09-09T12:30:00.000Z'),
      row('Other A', '2026-09-09T14:00:00.000Z', false, 'other', 'family', '2026-09-09T15:00:00.000Z'), row('Other B', '2026-09-09T14:30:00.000Z', false, 'other')]);
    const html = await home('UTC', role);
    expect(mocks.today.mock.calls[0][0].events.map((e: { title: string }) => e.title)).toEqual(['Mine A', 'Mine B']);
    expect(html).toContain('Alex: 2 events overlap');
    expect(html.includes('Other person: 2 events overlap')).toBe(role === 'parent');
    expect(db.log.some(entry => entry.table === 'parent_approvals')).toBe(role === 'parent');
  });

  it('a failed assigned read cannot revive a stale persisted calendar insight, while unrelated successful work stays', async () => {
    db.seed('daily_insights', [{ id: 'stale', family_id: 'family', as_of_date: '2026-09-09', kind: 'conflict', status: 'active', title: 'Stale private clash', detail: 'Old clash', impact: 100 }]);
    db.seed('todo_items', [{ id: 'task', family_id: 'family', title: 'Keep this task', due_date: '2026-09-09', is_done: false }]);
    db.seed('family_reminders', [{ id: 'reminder', family_id: 'family', title: 'Keep this reminder', remind_at: '2026-09-09T18:00:00.000Z', status: 'active', member_id: 'parent' }]);
    failCalendar(3, false); const html = await home();
    expect(html).not.toContain('Stale private clash'); expect(html).toContain('Keep this task'); expect(html).toContain('Keep this reminder');
    expect(db.table('daily_insights').some(entry => entry.id === 'stale')).toBe(true);
    expect(db.table('daily_insights').some(entry => entry.kind === 'meal')).toBe(true);
  });

  it('the actual Supabase transport requests complete family-scoped singles and older masters before visibility/presentation limits', async () => {
    const requests: URL[] = [];
    const client = createClient<Database>('https://synthetic-home.invalid', 'local-test-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url);
      if(url.pathname.endsWith('/calendar_events')) expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      return new Response('[]', { headers: { 'content-type': 'application/json', 'content-range': '*/0' } });
    } } });
    mocks.server.mockResolvedValue(client); await home('America/New_York');
    const calendar = requests.filter(url => url.pathname.endsWith('/calendar_events'));
    expect(calendar).toHaveLength(6);
    for (const url of calendar) {
      expect(url.searchParams.get('family_id')).toBe('eq.family');
      expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
      expect(url.searchParams.get('limit')).toBe('1000');
      const logic = url.searchParams.getAll('or');
      expect(url.searchParams.get('assignee_id')).toBeNull();
      if(url.searchParams.get('recurrence')==='neq.none') expect(url.searchParams.get('starts_at')).toMatch(/^lte\./);
      else { expect(logic).toHaveLength(2); expect(logic[0]).toContain('ends_at.gt.'); expect(logic[1]).toBe('(recurrence.is.null,recurrence.eq.none)'); }
    }
  });

  it.each(['inside interval', 'simultaneous points', 'positive overlap', 'legacy missing end'] as const)('%s preserves Home event rows and reports only positive-duration clashes', async scenario => {
    const point = row('Point event', '2026-09-09T12:30:00.000Z', false, 'parent', 'family', '2026-09-09T12:30:00.000Z');
    const interval = row('Meeting', '2026-09-09T12:00:00.000Z', false, 'parent', 'family', '2026-09-09T13:00:00.000Z');
    const other = scenario === 'simultaneous points' ? { ...point, id: 'second', title: 'Second point' } : interval;
    const second = scenario === 'positive overlap' ? { ...point, ends_at: '2026-09-09T13:30:00.000Z' } : scenario === 'legacy missing end' ? { ...point, ends_at: null } : point;
    db.seed('calendar_events', [other, second]); const before = structuredClone(db.table('calendar_events'));
    const html = await home(); expect(html).toContain(other.title); expect(html).toContain(second.title);
    expect(html.includes('2 events overlap')).toBe(scenario === 'positive overlap' || scenario === 'legacy missing end');
    expect(mocks.today.mock.calls[0][0].events).toHaveLength(2); expect(db.table('calendar_events')).toEqual(before);
  });

  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('%s renders calendar locale/family-zone labels and three independent retry/recovery states', async locale => {
    mocks.locale = locale;
    db.seed('calendar_events', [row('Today holiday {literal}', '2026-09-09T00:00:00.000Z', true), row('Family-zone meeting', '2026-09-09T22:00:00.000Z'),
      row('Tomorrow holiday {literal}', '2026-09-10T00:00:00.000Z', true), row('Upcoming meeting', '2026-09-10T22:00:00.000Z')]);
    const save = (state: string, html: string) => {
      const dir = process.env.BUBALY_HOME_BROWSER_DIR;
      if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${locale}-${state}.html`), html); }
    };
    const html = await home('America/New_York'); save('healthy', html);
    expect(html).toContain(translate(getMessages(locale), 'calendar.allDay'));
    expect(html).toContain(new Intl.DateTimeFormat(locale, { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date('2026-09-09T22:00:00Z')));
    expect(html).toContain(new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date('2026-09-10T12:00:00Z')));
    for (const read of [1, 2, 3]) {
      const failure = failCalendar(read, false); const degraded = await home('America/New_York'); save(`failed-${read}`, degraded);
      const notice = translate(getMessages(locale), ['homeCalendar.todayUnavailable', 'homeCalendar.upcomingUnavailable', 'homeCalendar.conflictsUnavailable'][read - 1]);
      expect(degraded).toContain(notice.replaceAll('&', '&amp;').replaceAll("'", '&#x27;'));
      expect(degraded).toContain(translate(getMessages(locale), 'root.tryAgain'));
      failure.mockRestore(); const recovered = await home('America/New_York');
      expect(recovered).toContain('Today holiday {literal}'); expect(recovered).not.toContain('role="status"');
    }
  });
});
