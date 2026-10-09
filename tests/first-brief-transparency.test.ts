import { describe, expect, it } from 'vitest';
import { buildFirstBrief, qualifyBriefEvents, briefEventIsOccupied, type BriefEvent } from '@/lib/onboarding/first-brief';
const now=new Date('2025-01-01T12:00:00Z');
const reference={kind:'source' as const,feedId:'20000000-0000-4000-8000-000000000001',uid:'synthetic',revisionId:'30000000-0000-4000-8000-000000000001',original:{kind:'utc' as const,value:'20250101T180000Z'}};
const source=(over:Partial<BriefEvent>={}):BriefEvent=>({title:'Free annotation',start:'2025-01-01T18:00:00Z',end:'2025-01-01T19:00:00Z',reference,occurrenceKey:'source-one',transparency:'transparent',...over});
const native:BriefEvent={title:'Commitment',start:'2025-01-01T18:30:00Z',end:'2025-01-01T19:30:00Z',location:'Office'};
describe('qualified briefing occupancy',()=>{
 it('keeps free events visible without clashes or modeled planning credit',()=>{const b=buildFirstBrief([source({recurring:true}),native],now);expect(b.todayCount).toBe(2);expect(b.conflicts).toEqual([]);expect(b.timeSavedMinutes).toBe(2);expect(b.actions.some(a=>a.kind==='location')).toBe(false);expect(b.timeline[0]).toMatchObject({transparency:'transparent',reference});});
 it.each([{}, {allDay:true,start:'2025-01-01',end:'2025-01-02'},{start:'2025-01-01T18:00:00Z',end:'2025-01-01T18:00:00Z'},{start:'2030-01-01T18:00:00Z',end:'2030-01-01T19:00:00Z'}])('refuses unqualified source before skipping %j',over=>{expect(()=>buildFirstBrief([source({...over,transparency:undefined})],now)).toThrow();});
 it('refuses a source disguised as native',()=>{expect(()=>buildFirstBrief([source({kind:'native'})],now)).toThrow();});
 it.each([true,false])('refuses contradictory duplicate identity in either order %s',reverse=>{const rows=[source(),source({transparency:'opaque'})];expect(()=>buildFirstBrief(reverse?rows.reverse():rows,now)).toThrow();});
 it('counts coherent source duplicates once',()=>{const b=buildFirstBrief([source(),source()],now);expect(b.todayCount).toBe(1);expect(b.timeSavedMinutes).toBe(0);expect(b.actions).toEqual([]);});
 it('retains opaque source conflict but never suggests editing its location',()=>{const b=buildFirstBrief([source({transparency:'opaque'}),native],now);expect(b.conflicts).toHaveLength(1);expect(b.actions.some(a=>a.kind==='location')).toBe(false);});
 it('preserves native missing-end hour and source missing-end point',()=>{const b=buildFirstBrief([source({transparency:'opaque',end:null}),{...native,start:'2025-01-01T18:00:00Z',end:null}],now);expect(b.todayCount).toBe(2);expect(b.conflicts).toEqual([]);expect(b.timeSavedMinutes).toBe(2);expect(b.timeline.every(e=>e.end===null)).toBe(true);});
});

const dateSource = (transparency: 'opaque' | 'transparent'): BriefEvent => source({allDay:true,start:'2025-01-01',end:'2025-01-02',startDate:'2025-01-01',endDate:'2025-01-02',reference:{...reference,original:{kind:'date',value:'20250101'}},transparency});
const dinner = ['quick','standard','involved'].flatMap(effort => Array.from({length:3},(_,i)=>({title:effort+i,cuisine:'Synthetic',effort,prepMinutes:20,description:null}))) as Parameters<typeof buildFirstBrief>[2];
describe('brief annotations and explicit dinner policy',()=>{
 it.each(['opaque','transparent'] as const)('preserves visible DATE metadata for %s',polarity=>{
  const b=buildFirstBrief([dateSource(polarity)],now);
  expect(b.todayCount).toBe(1);expect(b.weekCount).toBe(1);expect(b.timeSavedMinutes).toBe(0);
  expect(b.timeline[0]).toMatchObject({kind:'source',transparency:polarity,startDate:'2025-01-01',endDate:'2025-01-02'});
 });
 it('keeps opaque DATE dinner estimates while excluding free DATE annotations',()=>{
  const rows=(polarity:'opaque'|'transparent')=>Array.from({length:3},(_,i)=>({...dateSource(polarity),occurrenceKey:'date-'+i}));
  expect(buildFirstBrief(rows('opaque'),now,dinner).dinnerIdeas.every(idea=>idea.effort==='quick')).toBe(true);
  expect(buildFirstBrief(rows('transparent'),now,dinner).dinnerIdeas.every(idea=>idea.effort==='standard')).toBe(true);
 });
 it('does not model recurring free or point planning and prep work',()=>{
  for(const row of [source({recurring:true}),source({end:source().start,transparency:'opaque',recurring:true})]){
   const b=buildFirstBrief([row],now);expect(b.todayCount).toBe(1);expect(b.timeSavedMinutes).toBe(0);expect(b.actions).toEqual([]);expect(briefEventIsOccupied(row)).toBe(false);
  }
 });
 it.each([{kind:'source',reference:undefined},{kind:'unknown'},{transparency:'UNKNOWN'},{reference:{...reference,uid:'x'.repeat(4097)}},{reference:{...reference,uid:'invalid\nUID'}},{reference:{...reference,original:{kind:'date',value:'20250101'}}},{actualStartsAt:'bad'},{actualEndsAt:'2024-01-01T00:00:00Z'}])('refuses malformed qualification before window skip %j',extra=>{
  expect(()=>qualifyBriefEvents([source({...extra,start:'2030-01-01T18:00:00Z',end:'2030-01-01T19:00:00Z'} as Partial<BriefEvent>)])).toThrow();
 });
 it('uses actual original spans rather than clipped display clocks for occupancy',()=>{
  const e=source({start:'2024-12-31T23:00:00Z',end:'2025-01-01T00:30:00Z',actualStartsAt:'2024-12-31T23:00:00Z',actualEndsAt:'2025-01-01T00:30:00Z',transparency:'opaque'});
  const b=buildFirstBrief([e],now);expect(briefEventIsOccupied(e)).toBe(true);expect(b.timeline[0]).toMatchObject({actualStartsAt:e.actualStartsAt,actualEndsAt:e.actualEndsAt,reference});
 });
 it.each([true,false])('refuses conflicting original clocks on duplicate identities in either order %s',reverse=>{
  const rows=[source(),source({actualStartsAt:'2025-01-01T17:00:00Z'})];expect(()=>qualifyBriefEvents(reverse?rows.reverse():rows)).toThrow();
 });
});

describe('brief actual clock consistency',()=>{
 it.each([{actualStartsAt:'2025-01-01T20:00:00Z',actualEndsAt:'2025-01-01T21:00:00Z'},{actualEndsAt:null},{actualEndsAt:'2025-01-01T20:00:00Z'}])('refuses contradictory timed aliases before free skipping %j',extra=>expect(()=>qualifyBriefEvents([source(extra)])).toThrow());
 it('admits normalized source point and native missing-end estimate',()=>{
  expect(briefEventIsOccupied(source({end:null,actualEndsAt:source().start,transparency:'opaque'}))).toBe(false);
  expect(briefEventIsOccupied({...native,end:null,actualEndsAt:'2025-01-01T19:30:00Z'})).toBe(true);
  expect(briefEventIsOccupied({...native,end:null,actualEndsAt:null})).toBe(true);
 });
});

describe('qualified DATE and native metadata refusal',()=>{
 it.each([{startDate:'2025-01-02',endDate:'2025-01-03'},{endDate:'2025-01-03'}])('refuses contradictory free DATE civil aliases %j',extra=>expect(()=>qualifyBriefEvents([{...dateSource('transparent'),...extra}])).toThrow());
 it.each([{transparency:'transparent'},{startDate:'2025-01-01'},{endDate:'2025-01-02'}])('refuses invalid native start carrying explicit metadata %j',extra=>expect(()=>qualifyBriefEvents([{title:'Invalid qualified native',start:'bad',...extra} as BriefEvent])).toThrow());
 it('retains plain legacy invalid-start compatibility safely in the occupied helper',()=>expect(briefEventIsOccupied({title:'Old invalid row',start:'bad'})).toBe(false));
});
