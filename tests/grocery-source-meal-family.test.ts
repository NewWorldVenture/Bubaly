import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { addItems } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';
const activity = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: activity }));
const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001', foreignFamily='aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const user='bbbbbbbb-bbbb-4bbb-8bbb-000000000001', list='cccccccc-cccc-4ccc-8ccc-000000000001';
const ownMeal='dddddddd-dddd-4ddd-8ddd-000000000001', foreignMeal='dddddddd-dddd-4ddd-8ddd-000000000002', missingMeal='dddddddd-dddd-4ddd-8ddd-000000000003';
const secondOwnMeal='dddddddd-dddd-4ddd-8ddd-000000000004';
let rows: Record<string,unknown>[], mode: string, receipts: {method:string;table:string;payload?:Record<string,unknown>[];idFilter?:string|null}[];
let scope: ServiceScope;
let transportAssertionErrors: unknown[];
beforeEach(()=>{
 rows=[];mode='healthy';receipts=[];transportAssertionErrors=[];activity.mockReset();activity.mockResolvedValue(undefined);
 const db=createClient('https://synthetic-grocery-reference.invalid','synthetic-not-a-secret',{accessToken:async()=>null,
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:async(input,init)=>{
   try {
   const url=new URL(String(input));expect(url.origin).toBe('https://synthetic-grocery-reference.invalid');
   const table=url.pathname.slice('/rest/v1/'.length);expect(['grocery_lists','grocery_items','meals']).toContain(table);
   const method=String(init?.method);expect(['GET','POST']).toContain(method);
   const payload=init?.body ? JSON.parse(String(init.body)) as Record<string,unknown>[] : undefined;
   receipts.push({method,table,payload,idFilter:url.searchParams.get('id')});expect(receipts.length).toBeLessThanOrEqual(5);
   const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
   const denied=()=>reply({code:'42501',message:'Synthetic read or write refused'},403);
   if(method==='GET'){
    expect(url.searchParams.get('family_id')).toBe('eq.'+family);
    if(table==='grocery_lists'){expect(url.searchParams.get('id')).toBe('eq.'+list);return mode==='list-error'?denied():reply([{id:list}]);}
    if(table==='meals'){
     if(mode==='meal-error')return denied();
     const own={id:ownMeal,family_id:family};
     if(mode==='meal-null')return reply(null);
     if(mode==='meal-object')return reply(own);
     if(mode==='meal-scalar')return reply(false);
     if(mode==='meal-array-entry')return reply([[]]);
     if(mode==='meal-duplicate')return reply([own,own]);
     if(mode==='meal-foreign-receipt')return reply([{...own,family_id:foreignFamily}]);
     if(mode==='meal-unknown-receipt')return reply([{id:foreignMeal,family_id:family}]);
     if(mode==='meal-missing-family')return reply([{id:ownMeal}]);
     if(mode==='meal-nonstring-id')return reply([{id:7,family_id:family}]);
     const ids=url.searchParams.get('id');expect(ids).toBeTruthy();
     const all=[{id:ownMeal,family_id:family},{id:secondOwnMeal,family_id:family},{id:foreignMeal,family_id:foreignFamily}];
     return reply(all.filter(r=>r.family_id===family && ids!.includes(r.id)));
    }
    expect(url.searchParams.get('list_id')).toBe('eq.'+list);
    if(url.searchParams.get('select')==='name'){
     expect(url.searchParams.get('is_checked')).toBe('eq.false');
     return mode==='open-error'?denied():reply(mode==='duplicate'?[{name:'MILK'}]:[]);
    }
    expect(url.searchParams.get('id')).toMatch(/^in\./);
    return reply(mode==='readback-mismatch'?rows.map(r=>({...r,quantity:'wrong quantity'})):rows);
   }
   expect(method).toBe('POST');expect(table).toBe('grocery_items');expect(Array.isArray(payload)).toBe(true);
   if(mode==='insert-error')return denied();
   // Model ONLY the declared single-column FK: referenced id must exist.
   // Foreign-family existence satisfies this model. This is not PostgreSQL/RLS execution.
   if(payload!.some(r=>r.source_meal_id && ![ownMeal,secondOwnMeal,foreignMeal].includes(String(r.source_meal_id))))
    return reply({code:'23503',message:'Synthetic source meal id does not exist'},409);
   for(const row of payload!){expect(row.family_id).toBe(family);expect(row.list_id).toBe(list);expect(row.created_by).toBe(user);}
   rows=payload!.map((r,i)=>({id:'eeeeeeee-eeee-4eee-8eee-00000000000'+(i+1),is_checked:false,source_meal_id:null,...r}));
   return reply(rows,201);
   } catch (error) { transportAssertionErrors.push(error); throw error; }
  }},
 });
 scope={db,familyId:family,userId:user,memberId:null,role:'parent',actorKind:'member',tz:'UTC'};
});
afterEach(()=>{
 expect(transportAssertionErrors).toEqual([]);
 expect(receipts.length).toBeLessThanOrEqual(5);
});
const post=()=>receipts.filter(r=>r.method==='POST');
const mealReads=()=>receipts.filter(r=>r.table==='meals');
const item=(sourceMealId?:string|null)=>({name:'Milk',quantity:'1 carton',category:'dairy',sourceMealId});
it.each([{name:'foreign existing meal',id:foreignMeal},{name:'nonexistent meal',id:missingMeal}])('refuses $name before any insert or activity',async({id})=>{
 const result=await addItems(scope,{listId:list,items:[item(id)]});
 expect(result).toMatchObject({ok:false,code:'not_found'});
 expect(post()).toHaveLength(0);expect(rows).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
it('an own-family meal reference retains verified content and one activity',async()=>{
 const result=await addItems(scope,{listId:list,items:[item(ownMeal)]});
 expect(result).toMatchObject({ok:true,data:{listId:list,added:[{source_meal_id:ownMeal,name:'Milk',quantity:'1 carton',category:'dairy'}],skipped:[]}});
 expect(post()).toHaveLength(1);expect(rows).toHaveLength(1);expect(activity).toHaveBeenCalledTimes(1);
});
it.each([{name:'omitted',ref:undefined},{name:'null',ref:null}])('$name reference preserves four old requests and makes no meal read',async({ref})=>{
 expect(await addItems(scope,{listId:list,items:[item(ref)]})).toMatchObject({ok:true});
 expect(rows[0].source_meal_id).toBeNull();expect(mealReads()).toHaveLength(0);
 expect(receipts.map(r=>r.method)).toEqual(['GET','GET','POST','GET']);expect(activity).toHaveBeenCalledTimes(1);
});
it('an already-open normalized duplicate remains a no-op even with a foreign supplied reference',async()=>{
 mode='duplicate';
 expect(await addItems(scope,{listId:list,items:[item(foreignMeal)]})).toMatchObject({ok:true,data:{added:[],skipped:['Milk']}});
 expect(receipts).toHaveLength(2);expect(mealReads()).toHaveLength(0);expect(post()).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
it('a failed meal reference read refuses before an insert or activity',async()=>{
 mode='meal-error';
 expect(await addItems(scope,{listId:list,items:[item(ownMeal)]})).toMatchObject({ok:false,code:'db'});
 expect(post()).toHaveLength(0);expect(rows).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
it.each(['list-error','open-error','insert-error'])('existing %s refusal never creates a confirmed item or activity',async(errorMode)=>{
 mode=errorMode;
 expect(await addItems(scope,{listId:list,items:[item()]})).toMatchObject({ok:false,code:'db'});
 expect(rows).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
 expect(post()).toHaveLength(errorMode==='insert-error'?1:0);expect(mealReads()).toHaveLength(0);
});
it('an inconsistent post-save readback retains the existing uncertain-save refusal',async()=>{
 mode='readback-mismatch';
 expect(await addItems(scope,{listId:list,items:[item()]})).toMatchObject({ok:false,code:'db'});
 expect(rows).toHaveLength(1);expect(post()).toHaveLength(1);expect(activity).not.toHaveBeenCalled();expect(mealReads()).toHaveLength(0);
});

it('batches unique own meal IDs across mixed rows and keeps verified associations',async()=>{
 const result=await addItems(scope,{listId:list,items:[item(ownMeal),{...item(ownMeal),name:'Eggs'},{...item(secondOwnMeal),name:'Bread'},{...item(null),name:'Bananas'}]});
 expect(result).toMatchObject({ok:true,data:{added:[{source_meal_id:ownMeal},{source_meal_id:ownMeal},{source_meal_id:secondOwnMeal},{source_meal_id:null}]}});
 expect(mealReads()).toHaveLength(1);expect(mealReads()[0].idFilter).toBe('in.('+ownMeal+','+secondOwnMeal+')');
 expect(receipts).toHaveLength(5);expect(post()).toHaveLength(1);expect(activity).toHaveBeenCalledTimes(1);
});
it('one missing family reference refuses the complete batch before any insert',async()=>{
 expect(await addItems(scope,{listId:list,items:[item(ownMeal),{...item(foreignMeal),name:'Eggs'}]})).toMatchObject({ok:false,code:'not_found'});
 expect(mealReads()).toHaveLength(1);expect(rows).toHaveLength(0);expect(post()).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
it('a skipped foreign reference does not block an unreferenced new row or cause a meal read',async()=>{
 mode='duplicate';
 expect(await addItems(scope,{listId:list,items:[item(foreignMeal),{...item(null),name:'Eggs'}]})).toMatchObject({ok:true,data:{added:[{name:'Eggs',source_meal_id:null}],skipped:['Milk']}});
 expect(mealReads()).toHaveLength(0);expect(rows).toHaveLength(1);expect(activity).toHaveBeenCalledTimes(1);
});
it('a skipped malformed reference remains the old normalized duplicate no-op',async()=>{
 mode='duplicate';
 expect(await addItems(scope,{listId:list,items:[{...item(),sourceMealId:[] as unknown as string}]})).toMatchObject({ok:true,data:{added:[],skipped:['Milk']}});
 expect(receipts).toHaveLength(2);expect(mealReads()).toHaveLength(0);expect(post()).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
it.each([{name:'zero',ref:0},{name:'false',ref:false},{name:'array',ref:[]},{name:'object',ref:{}},{name:'blank',ref:'   '}])('refuses malformed inserted source reference $name before POST',async({ref})=>{
 expect(await addItems(scope,{listId:list,items:[{...item(),sourceMealId:ref as string}]})).toMatchObject({ok:false,code:'invalid_input'});
 expect(mealReads()).toHaveLength(0);expect(post()).toHaveLength(0);expect(rows).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
it.each(['meal-null','meal-object','meal-scalar','meal-array-entry','meal-duplicate','meal-foreign-receipt','meal-unknown-receipt','meal-missing-family','meal-nonstring-id'])('refuses %s reference receipts before POST',async(receiptMode)=>{
 mode=receiptMode;
 expect(await addItems(scope,{listId:list,items:[item(ownMeal)]})).toMatchObject({ok:false,code:'db'});
 expect(post()).toHaveLength(0);expect(rows).toHaveLength(0);expect(activity).not.toHaveBeenCalled();
});
