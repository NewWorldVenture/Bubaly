import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {writeFileSync} from 'node:fs';
import {planWeek} from '@/lib/services/meals';
import type {ServiceScope} from '@/lib/services/types';

// Only activity recording is inert; no Auth/context/provider/medical route is loaded.
const seams=vi.hoisted(()=>({activity:[] as unknown[],forbidden:[] as string[]}));
vi.mock('@/lib/services/activity',()=>({recordActivitySafely:async(_s:unknown,event:unknown)=>{seams.activity.push(event);}}));
vi.mock('@/lib/services/family',()=>({getMembers:()=>{seams.forbidden.push('getMembers');throw Error('Unexecuted family seam');}}));
vi.mock('@/lib/services/idempotency',()=>({withIdempotency:()=>{seams.forbidden.push('withIdempotency');throw Error('Unexecuted idempotency seam');}}));
vi.mock('@/lib/meals/pantry-chef',()=>({normalizeAllergies:()=>{seams.forbidden.push('normalizeAllergies');throw Error('Unexecuted food profile seam');}}));

const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',other='bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const date='2026-09-08',user='cccccccc-cccc-4ccc-8ccc-000000000003';
const old={id:'old-slot',family_id:family,meal_id:'old-dish',plan_date:date,meal_type:'dinner',created_by:user,idempotency_key:'original-key'};
const untouched={id:'unrelated-slot',family_id:family,meal_id:'old-dish',plan_date:date,meal_type:'lunch',created_by:user,idempotency_key:null};
const foreign={id:'foreign-slot',family_id:other,meal_id:'old-dish',plan_date:date,meal_type:'dinner',created_by:user,idempotency_key:null};
const race={...old,id:'competing-slot',meal_id:'competing-dish',idempotency_key:null};
const dish={id:'existing-dish',family_id:family,name:'Synthetic ordinary meal',meal_type:'dinner',ingredients:[],created_by:user};
type Row=Record<string,unknown>;
type Receipt={method:string;table:string;query:string;body:unknown;status:number;reply:unknown};
let rows:Row[],requests:Receipt[],deleteMode:string,insertMode:string,snapshotMode:string,readbackMode:string,competing:boolean,result:unknown,thrown:string|undefined;
let initialDelete:boolean,initialInsert:boolean;
let transportErrors:string[];
const allCases:unknown[]=[];
beforeEach(()=>{rows=structuredClone([old,untouched,foreign]);requests=[];transportErrors=[];deleteMode='healthy';insertMode='healthy';snapshotMode='healthy';readbackMode='healthy';competing=false;result=undefined;thrown=undefined;initialDelete=true;initialInsert=true;seams.activity.length=0;seams.forbidden.length=0;});
afterEach((ctx)=>{
  allCases.push({name:ctx.task.name,result,thrown,requests,rows,activity:[...seams.activity],forbidden:[...seams.forbidden],transportErrors:[...transportErrors]});
  if(process.env.BUBALY_MEALS_RECEIPTS)writeFileSync(process.env.BUBALY_MEALS_RECEIPTS,JSON.stringify(allCases,null,2)+'\n');
  expect.soft(seams.forbidden).toEqual([]);expect.soft(requests.length).toBeLessThanOrEqual(12);
  expect.soft(transportErrors).toEqual([]);
  expect.soft(rows.find(r=>r.id===untouched.id)).toEqual(untouched);expect.soft(rows.find(r=>r.id===foreign.id)).toEqual(foreign);
});
function anomaly(mode:string,expected:Row[]):unknown{
  if(mode==='object')return {0:expected[0],length:1};
  if(mode==='string')return 'X';
  if(mode==='null')return null;
  if(mode==='wrong-array')return [{...expected[0],id:'wrong-receipt-id'}];
  if(mode==='false')return false;
  if(mode==='true')return true;
  if(mode==='zero')return 0;
  if(mode==='one')return 1;
  if(mode==='empty-string')return '';
  if(mode==='object-zero')return {length:0};
  if(mode==='object-one')return {length:1};
  if(mode==='object-no-length')return {};
  if(mode==='empty-array')return [];
  if(mode==='null-entry')return [null];
  if(mode==='scalar-entry')return [7];
  return expected;
}
function scope():ServiceScope{
  const db=createClient('https://synthetic-planweek.invalid','synthetic-not-a-secret',{accessToken:async()=>null,
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:async(input,init)=>{
      try{
      const u=new URL(String(input)),method=init?.method??'GET',table=u.pathname.split('/').pop()??'';
      const body=init?.body?JSON.parse(String(init.body)):null;
      const refuse=(message:string):never=>{seams.forbidden.push(message);throw Error(message);};
      if(u.origin!=='https://synthetic-planweek.invalid'||!['meals','meal_plans'].includes(table)||!['GET','DELETE','POST'].includes(method))refuse('Unexpected transport route');
      if(requests.length>=12)refuse('Finite transport bound exceeded');
      if(method!=='POST'&&u.searchParams.get('family_id')!=='eq.'+family)refuse('Unscoped read/delete');
      if(method==='POST'&&(table!=='meal_plans'||!Array.isArray(body)||body.some((r:Row)=>r.family_id!==family)))refuse('Unexpected insert');
      const filter=(r:Row)=>[...u.searchParams].every(([k,v])=>{
        if(['select','order','offset','limit'].includes(k))return true;
        if(v.startsWith('eq.'))return String(r[k])===v.slice(3);
        if(v.startsWith('in.('))return v.slice(4,-1).split(',').map(x=>x.replace(/^"|"$/g,'')).includes(String(r[k]));
        return refuse('Unexpected synthetic filter '+k);
      });
      let status=200,reply:unknown;
      if(table==='meals'){
        if(method!=='GET')refuse('Meal library write forbidden');
        reply=filter(dish)?[dish]:[];
      }else if(method==='GET'){
        reply=rows.filter(filter);
        if(requests.filter(r=>r.table==='meal_plans'&&r.method==='GET').length===0&&snapshotMode==='object')reply={length:1};
        if(requests.filter(r=>r.table==='meal_plans'&&r.method==='GET').length===2&&readbackMode==='object')reply={length:1};
      }else if(method==='DELETE'){
        const selected=rows.filter(filter);
        const isCaptured=initialDelete&&u.searchParams.has('meal_type');
        if(isCaptured)initialDelete=false;
        if(isCaptured&&deleteMode==='error'){status=403;reply={code:'42501',message:'Synthetic delete refused'};}
        else{rows=rows.filter(r=>!filter(r));reply=isCaptured?anomaly(deleteMode,selected):selected;}
      }else{
        const isReplacement=initialInsert&&body.some((r:Row)=>r.id!==old.id);
        if(isReplacement)initialInsert=false;
        status=201;
        if(isReplacement&&insertMode==='error'){status=403;reply={code:'42501',message:'Synthetic insert refused'};}
        else{rows.push(...structuredClone(body));reply=isReplacement?anomaly(insertMode,body):body;}
        if(isReplacement&&competing)rows.push(structuredClone(race));
      }
      requests.push({method,table,query:u.search,body,status,reply:structuredClone(reply)});
      return new Response(JSON.stringify(reply),{status,headers:{'content-type':'application/json'}});
      }catch(error){transportErrors.push(error instanceof Error?error.message:String(error));throw error;}
    }},
  });
  return {db:db as ServiceScope['db'],familyId:family,userId:user,memberId:null,role:'parent',actorKind:'member',tz:'UTC',now:new Date('2026-09-08T12:00:00Z')};
}
async function invoke(entries=[{date,mealType:'dinner' as const,mealId:dish.id}]){
  try{result=await planWeek(scope(),entries);}catch(error){thrown=error instanceof Error?error.message:String(error);}
}
function refusal(restored=true){
  expect.soft(thrown).toBeUndefined();expect.soft(result).toMatchObject({ok:false,code:'db',error:expect.any(String)});
  expect.soft(seams.activity).toEqual([]);
  expect.soft(rows.filter(r=>r.family_id===family&&r.meal_type==='dinner')).toEqual(restored?[old]:[race]);
  expect.soft(requests.some(r=>r.method==='POST'&&Array.isArray(r.body)&&(r.body as Row[]).some(row=>row.id===old.id))).toBe(restored&&deleteMode!=='error'&&snapshotMode!=='object');
}

it.each(['object','string'])('SDK200 captured delete $0 is refused and restores the original slot',async(mode)=>{deleteMode=mode;await invoke();refusal();expect.soft(requests.filter(r=>r.method==='POST').map(r=>r.body)).toEqual([[old]]);expect.soft(requests.some(r=>r.method==='DELETE'&&r.query.includes('id=in.%28old-slot%29'))).toBe(true);});
it.each(['object','string'])('SDK201 insert $0 is refused, removes only owned inserted IDs and restores original slot',async(mode)=>{insertMode=mode;await invoke();refusal();const writes=requests.filter(r=>r.method!=='GET');expect.soft(writes.map(r=>r.method)).toEqual(['DELETE','POST','DELETE','POST']);expect.soft(writes[2]?.query).toContain('id=in.');expect.soft(writes[2]?.query).not.toContain('old-slot');expect.soft(writes[3]?.body).toEqual([old]);});
it('healthy SDK arrays confirm only the submitted replacement and record inert activity once',async()=>{await invoke();expect(thrown).toBeUndefined();expect(result).toMatchObject({ok:true,data:{replaced:1,createdMeals:0,planned:[{date,mealType:'dinner',mealId:dish.id,name:dish.name,ingredients:[]}]}});const target=rows.filter(r=>r.family_id===family&&r.meal_type==='dinner');expect(target).toHaveLength(1);expect(target[0]).toMatchObject({family_id:family,meal_id:dish.id,plan_date:date,meal_type:'dinner',created_by:user});expect(target[0].id).not.toBe(old.id);expect(seams.activity).toHaveLength(1);expect(requests.filter(r=>r.method!=='GET').map(r=>r.method)).toEqual(['DELETE','POST']);});
it.each(['null','wrong-array','error'])('captured delete $0 control refuses and retains/restores original slot',async(mode)=>{deleteMode=mode;await invoke();refusal();expect(requests.filter(r=>r.method==='POST').length).toBe(mode==='error'?0:1);});
it.each(['null','wrong-array','error'])('insert $0 control refuses and compensates submitted IDs',async(mode)=>{insertMode=mode;await invoke();refusal();expect(requests.filter(r=>r.method==='DELETE')).toHaveLength(2);});
it('wrong insert array with competing row preserves competitor and reports incomplete restoration',async()=>{insertMode='wrong-array';competing=true;await invoke();refusal(false);expect(result).toMatchObject({ok:false,error:expect.stringContaining('refresh before trying again')});expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);expect(rows.some(r=>r.id===old.id)).toBe(false);});
it('malformed initial snapshot is refused before any destructive write',async()=>{snapshotMode='object';await invoke();expect(thrown).toBeUndefined();expect(result).toMatchObject({ok:false,code:'db'});expect(rows).toEqual([old,untouched,foreign]);expect(requests.map(r=>r.method)).toEqual(['GET','GET']);expect(seams.activity).toEqual([]);});
it('invalid empty entries refuse without any SDK request',async()=>{await invoke([]);expect(thrown).toBeUndefined();expect(result).toMatchObject({ok:false,code:'invalid_input'});expect(requests).toEqual([]);expect(rows).toEqual([old,untouched,foreign]);expect(seams.activity).toEqual([]);});

// All fourteen original complete test declarations above remain byte-for-byte.
const otherBodies=['false','true','zero','one','empty-string','object-zero','object-one','object-no-length','empty-array','null-entry','scalar-entry'];
it.each(otherBodies)('captured delete %s receipt resolves refusal and exact compensation',async(mode)=>{deleteMode=mode;await invoke();refusal();expect.soft(requests.filter(r=>r.method!=='GET').map(r=>r.method)).toEqual(['DELETE','POST']);expect.soft(requests.find(r=>r.method==='POST')?.body).toEqual([old]);});
it.each(otherBodies)('insert %s receipt resolves refusal with owned-ID compensation',async(mode)=>{insertMode=mode;await invoke();refusal();const writes=requests.filter(r=>r.method!=='GET');expect.soft(writes.map(r=>r.method)).toEqual(['DELETE','POST','DELETE','POST']);expect.soft(writes[2]?.query).not.toContain('old-slot');expect.soft(writes[3]?.body).toEqual([old]);});
it('malformed confirmation read retains existing unconfirmed-save refusal semantics',async()=>{readbackMode='object';await invoke();expect(thrown).toBeUndefined();expect(result).toMatchObject({ok:false,code:'db',error:'Could not confirm the saved meal plan. Refresh before trying again.'});expect(seams.activity).toEqual([]);const target=rows.filter(r=>r.family_id===family&&r.meal_type==='dinner');expect(target).toHaveLength(1);expect(target[0]).toMatchObject({meal_id:dish.id,plan_date:date,meal_type:'dinner',created_by:user});expect(target[0].id).not.toBe(old.id);expect(requests.filter(r=>r.method!=='GET').map(r=>r.method)).toEqual(['DELETE','POST']);});
