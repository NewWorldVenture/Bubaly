// A meal plan that ignores the calendar plans a week the family does not have.
//
// `scoreWeekNights` is the fact-finder behind the planner's busy-night line: it
// reads `calendar_events` rows as they come out of Supabase, resolves each one
// into the FAMILY's zone, and measures how much of the dinner window it eats.
// The cases below pin the four things the prompt then depends on — which nights
// count as busy, that a zone actually changes the answer, that all-day rows are
// not evenings, and that a clear week produces no hint at all rather than a
// negated one.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSY_MINUTES, DINNER_WINDOW, quickMealHint, scoreWeekNights, weekdayName,
  type WeekCalendarEvent,
} from '@/lib/meals/week-context';
import { buildPlannerUser, type PlannerRequest } from '@/lib/meals/planner';

const WEEK = '2026-09-07'; // a Monday
const NY = 'America/New_York';

/** An event at a local wall-clock time in New York (EDT, UTC-4 in September). */
function nyEvent(dayKey: string, startLocalHour: number, minutes: number, title: string): WeekCalendarEvent {
  const startsUtc = Date.parse(`${dayKey}T${String(startLocalHour + 4).padStart(2, '0')}:00:00Z`);
  return {
    title,
    starts_at: new Date(startsUtc).toISOString(),
    ends_at: new Date(startsUtc + minutes * 60_000).toISOString(),
    all_day: false,
    category: 'general',
  };
}

describe('scoreWeekNights', () => {
  it('covers Monday to Sunday and names the weekday of each night', () => {
    const context = scoreWeekNights(WEEK, [], { tz: NY });
    expect(context.nights).toHaveLength(7);
    expect(context.nights.map((n) => n.date)).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ]);
    expect(context.nights[0].weekday).toBe('Monday');
    expect(context.nights[6].weekday).toBe('Sunday');
    expect(weekdayName('2026-09-09')).toBe('Wednesday');
  });

  it('a clear week is busy on no night and produces NO hint', () => {
    const context = scoreWeekNights(WEEK, [
      // 09:00 dentist: nowhere near dinner.
      nyEvent('2026-09-08', 9, 60, 'Dentist'),
    ], { tz: NY });
    expect(context.busyNights).toEqual([]);
    expect(context.hint).toBeNull();
    expect(context.nights[1].eveningMinutes).toBe(0);
  });

  it('an evening commitment past the threshold makes the night busy and names the event', () => {
    const context = scoreWeekNights(WEEK, [
      nyEvent('2026-09-08', 17, 90, 'Swim practice'),
    ], { tz: NY });
    const tuesday = context.nights.find((n) => n.date === '2026-09-08')!;
    expect(tuesday.eveningMinutes).toBe(90);
    expect(tuesday.busy).toBe(true);
    expect(tuesday.events).toEqual(['Swim practice']);
    expect(context.busyNights).toEqual([
      { date: '2026-09-08', weekday: 'Tuesday', reason: 'Swim practice' },
    ]);
  });

  it('two short evening events add up to a busy night, in start order', () => {
    const context = scoreWeekNights(WEEK, [
      nyEvent('2026-09-10', 18, 30, 'Piano'),
      nyEvent('2026-09-10', 16, 30, 'Pickup'),
    ], { tz: NY });
    const thursday = context.nights.find((n) => n.date === '2026-09-10')!;
    expect(thursday.eveningMinutes).toBe(60);
    expect(thursday.eveningMinutes).toBeGreaterThanOrEqual(DEFAULT_BUSY_MINUTES);
    expect(thursday.busy).toBe(true);
    expect(thursday.events).toEqual(['Pickup', 'Piano']);
  });

  it('counts only the part of an event that lands inside the dinner window', () => {
    // 14:00 → 22:00. Only 16:00–20:00 is dinner time: four hours, not eight.
    const context = scoreWeekNights(WEEK, [nyEvent('2026-09-09', 14, 8 * 60, 'Away game')], { tz: NY });
    const wednesday = context.nights.find((n) => n.date === '2026-09-09')!;
    expect(wednesday.eveningMinutes).toBe((DINNER_WINDOW.endHour - DINNER_WINDOW.startHour) * 60);
    expect(wednesday.busy).toBe(true);
  });

  it('an all-day row is not an evening — a school holiday makes cooking easier, not harder', () => {
    const context = scoreWeekNights(WEEK, [
      { title: 'School holiday', starts_at: '2026-09-09T00:00:00Z', ends_at: '2026-09-10T00:00:00Z', all_day: true },
    ], { tz: NY });
    expect(context.busyNights).toEqual([]);
    expect(context.nights.every((n) => n.eveningMinutes === 0)).toBe(true);
  });

  it('the FAMILY zone decides which night an event lands on, not the server', () => {
    // 2026-09-09T01:00:00Z is Wednesday 01:00 UTC — but Tuesday 21:00 in New York
    // and Tuesday 18:00 in Los Angeles, which is dinner time only in the latter.
    const event: WeekCalendarEvent = {
      title: 'Late practice', starts_at: '2026-09-09T01:00:00Z', ends_at: '2026-09-09T03:00:00Z', all_day: false,
    };
    const la = scoreWeekNights(WEEK, [event], { tz: 'America/Los_Angeles' });
    expect(la.busyNights.map((n) => n.date)).toEqual(['2026-09-08']);

    const utc = scoreWeekNights(WEEK, [event], { tz: 'UTC' });
    // 01:00–03:00 UTC on Wednesday is the middle of the night: no dinner overlap.
    expect(utc.busyNights).toEqual([]);
  });

  it('drops valid events outside the week', () => {
    const context = scoreWeekNights(WEEK, [
      nyEvent('2026-09-20', 18, 120, 'Next fortnight'),
      nyEvent('2026-09-11', 18, 60, 'Friday football'),
    ], { tz: NY });
    expect(context.busyNights.map((n) => n.date)).toEqual(['2026-09-11']);
  });

  it('an event with no end time is assumed to be an hour long', () => {
    const context = scoreWeekNights(WEEK, [
      { title: 'Rehearsal', starts_at: '2026-09-07T22:00:00Z', ends_at: null, all_day: false },
    ], { tz: NY });
    const monday = context.nights[0];
    expect(monday.eveningMinutes).toBe(60);
    expect(monday.busy).toBe(true);
  });

  it('an unknown timezone refuses instead of inventing a clear UTC week', () => {
    expect(() => scoreWeekNights(WEEK, [
      { title: 'Practice', starts_at: '2026-09-08T18:00:00Z', ends_at: '2026-09-08T19:30:00Z' },
    ], { tz: 'Mars/Olympus_Mons' })).toThrow('Invalid meal calendar timezone');
  });

  it('a raised threshold can make the same night ordinary', () => {
    const events = [nyEvent('2026-09-08', 17, 50, 'Swim practice')];
    expect(scoreWeekNights(WEEK, events, { tz: NY }).busyNights).toHaveLength(1);
    expect(scoreWeekNights(WEEK, events, { tz: NY, busyMinutes: 120 }).busyNights).toHaveLength(0);
  });

  it('a malformed week start yields no nights rather than throwing', () => {
    const context = scoreWeekNights('not-a-week', [nyEvent('2026-09-08', 18, 90, 'Swim')], { tz: NY });
    expect(context.nights).toEqual([]);
    expect(context.hint).toBeNull();
  });
});

describe('actual dinner interval occupancy',()=>{
  it('measures negative-epoch dinner instants and refuses a zero busy threshold',()=>{
    expect(scoreWeekNights('1960-01-04',[{starts_at:'1960-01-04T18:00:00Z',ends_at:'1960-01-04T19:00:00Z'}]).nights[0].eveningMinutes).toBe(60);
    expect(()=>scoreWeekNights(WEEK,[],{busyMinutes:0})).toThrow('Invalid busy threshold');
  });
  it('counts each occupied dinner on a multi-day trip, including a start before the week',()=>{
    const result=scoreWeekNights(WEEK,[{title:'Away',starts_at:'2026-09-06T10:00:00Z',ends_at:'2026-09-09T18:00:00Z'}]);
    expect(result.nights.map(n=>n.eveningMinutes)).toEqual([240,240,120,0,0,0,0]);
  });
  it('unions concurrent commitments instead of counting the same dinner minutes twice',()=>{
    const events=Array.from({length:3},(_,i)=>({title:`Concurrent${i}`,starts_at:'2026-09-07T18:00:00Z',ends_at:'2026-09-07T18:20:00Z'}));
    expect(scoreWeekNights(WEEK,events).nights[0]).toMatchObject({eveningMinutes:20,busy:false,events:['Concurrent0','Concurrent1','Concurrent2']});
  });
  it('explicit and source implicit points are zero; native missing-end remains one hour',()=>{
    expect(scoreWeekNights(WEEK,[{starts_at:'2026-09-07T18:00:00Z',ends_at:'2026-09-07T18:00:00Z'},{kind:'source',starts_at:'2026-09-07T18:00:00Z',ends_at:null}]).busyNights).toEqual([]);
    expect(scoreWeekNights(WEEK,[{kind:'native',starts_at:'2026-09-07T18:00:00Z',ends_at:null}]).nights[0].eveningMinutes).toBe(60);
  });
  it.each([['2026-03-02','2026-03-07T23:00:00Z','2026-03-09T00:00:00Z'],['2026-10-26','2026-10-31T22:00:00Z','2026-11-02T01:00:00Z']])('DST week %s counts Sunday dinner by actual family instants',(week,start,end)=>{
    expect(scoreWeekNights(week,[{starts_at:start,ends_at:end}],{tz:NY}).nights.at(-1)?.eveningMinutes).toBe(240);
  });
  it('rejects malformed/reversed data and conflicting identities rather than a clear week',()=>{
    for(const row of [{starts_at:'bad'},{starts_at:'2026-09-07T18:00:00Z',ends_at:'bad'},{starts_at:'2026-09-07T18:00:00Z',ends_at:'2026-09-07T17:00:00Z'}])expect(()=>scoreWeekNights(WEEK,[row])).toThrow('Invalid meal calendar interval');
    expect(()=>scoreWeekNights(WEEK,[{occurrenceKey:'same',starts_at:'2026-09-07T18:00:00Z',ends_at:null},{occurrenceKey:'same',starts_at:'2026-09-07T19:00:00Z',ends_at:null}])).toThrow('Conflicting meal calendar occurrence');
  });
  it('deduplicates only explicit original keys and keeps DATE annotations outside cooking occupancy',()=>{
    const e={occurrenceKey:'source-original',title:'Travel',starts_at:'2026-09-07T18:00:00Z',ends_at:'2026-09-07T19:00:00Z'};
    expect(scoreWeekNights(WEEK,[e,e,{title:'Holiday',all_day:true,starts_at:'2026-09-07',ends_at:'2026-09-10'}]).nights[0]).toMatchObject({eveningMinutes:60,events:['Travel']});
  });
});

describe('quickMealHint', () => {
  it('is null for a clear week — the model reads an absent constraint, not a negated one', () => {
    expect(quickMealHint([])).toBeNull();
  });

  it('names each busy night with its date and its reason', () => {
    const hint = quickMealHint([
      { date: '2026-09-08', weekday: 'Tuesday', reason: 'Swim practice' },
      { date: '2026-09-10', weekday: 'Thursday', reason: 'Piano, Pickup' },
    ]);
    expect(hint).toContain('Tuesday 2026-09-08 (Swim practice)');
    expect(hint).toContain('Thursday 2026-09-10 (Piano, Pickup)');
    expect(hint).toMatch(/20-minute|make-ahead/);
  });
});

describe('the planner prompt carries the busy nights', () => {
  const base: PlannerRequest = {
    weekStart: WEEK,
    mealTypes: ['dinner'],
    candidates: [{ ref: 'meal:1', name: 'Tacos', type: 'dinner', flags: [], votes: 2 }],
  };

  it('says nothing about busy nights when the week is clear', () => {
    expect(buildPlannerUser(base)).not.toMatch(/Busy evenings/);
  });

  it('adds one line naming the busy dates and the events behind them', () => {
    const prompt = buildPlannerUser({
      ...base,
      busyNights: scoreWeekNights(WEEK, [nyEvent('2026-09-08', 17, 90, 'Swim practice')], { tz: NY }).busyNights,
    });
    expect(prompt).toContain('Busy evenings');
    expect(prompt).toContain('Tuesday 2026-09-08 (Swim practice)');
  });
});
