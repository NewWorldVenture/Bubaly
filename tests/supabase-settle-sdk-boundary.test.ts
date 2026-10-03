import { afterEach, beforeEach, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { settle, settleAll } from '@/lib/supabase/settle';
const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const healthyId='bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
let requests: {method:string;path:string;subject:string}[];
let fixtureErrors: unknown[];
beforeEach(()=>{requests=[];fixtureErrors=[];});
afterEach(()=>{
 expect(fixtureErrors).toEqual([]);
 expect(requests.length).toBeLessThanOrEqual(2);
 expect(requests.length).toBeGreaterThanOrEqual(1);
});
function query(mode:'success'|'http-error'|'reject',cause?:unknown,throwOnError=false){
 const db=createClient('https://synthetic-settle-boundary.invalid','synthetic-not-a-secret',{accessToken:async()=>null,
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:async(input,init)=>{
   try{
    const url=new URL(String(input));
    expect(url.origin).toBe('https://synthetic-settle-boundary.invalid');
    expect(url.pathname).toBe('/rest/v1/notes');
    expect(init?.method).toBe('GET');
    expect(url.searchParams.get('family_id')).toBe('eq.'+family);
    requests.push({method:String(init?.method),path:url.pathname,subject:family});
    expect(requests.length).toBeLessThanOrEqual(2);
   }catch(error){fixtureErrors.push(error);throw error;}
   // These are intentional modeled transport outcomes, distinct from fixture assertions.
   if(mode==='reject')throw cause;
   const body=mode==='success'?[{id:healthyId}]:{code:'42501',message:'Synthetic HTTP refusal'};
   return new Response(JSON.stringify(body),{status:mode==='success'?200:403,headers:{'content-type':'application/json'}});
  }},
 });
 const builder=db.from('notes').select('id').eq('family_id',family).retry(false);
 return throwOnError ? builder.throwOnError() : builder;
}
const fallback=(message:string)=>({data:null,count:null,error:{message}});
it('keeps a normal SDK success without changing its data',async()=>{
 expect(await settle(query('success'))).toMatchObject({data:[{id:healthyId}],error:null});
 expect(requests).toHaveLength(1);
});
it('keeps a normal SDK HTTP error as a query error',async()=>{
 expect(await settle(query('http-error'))).toMatchObject({data:null,error:{code:'42501',message:'Synthetic HTTP refusal'}});
 expect(requests).toHaveLength(1);
});
it('turns SDK throwOnError HTTP refusal into the existing fallback',async()=>{
 expect(await settle(query('http-error',undefined,true))).toEqual(fallback('Synthetic HTTP refusal'));
 expect(requests).toHaveLength(1);
});
it('turns an ordinary SDK transport Error into the existing fallback',async()=>{
 expect(await settle(query('reject',new Error('Synthetic ordinary transport refusal'),true))).toEqual(fallback('Synthetic ordinary transport refusal'));
 expect(requests).toHaveLength(1);
});
it('retains the existing primitive rejection message through the actual SDK',async()=>{
 expect(await settle(query('reject','SYNTHETIC_ECONNRESET',true))).toEqual(fallback('SYNTHETIC_ECONNRESET'));
 expect(requests).toHaveLength(1);
});
it('retains existing plain-object rejection conversion through the actual SDK',async()=>{
 expect(await settle(query('reject',{message:'Synthetic object rejection'},true))).toEqual(fallback('[object Object]'));
 expect(requests).toHaveLength(1);
});
it('retains existing null rejection conversion through the actual SDK',async()=>{
 expect(await settle(query('reject',null,true))).toEqual(fallback('null'));
 expect(requests).toHaveLength(1);
});
it('settles an actual SDK rejection whose null-prototype cause cannot be stringified',async()=>{
 const cause=Object.assign(Object.create(null) as Record<string,unknown>,{message:'Synthetic dictionary rejection'});
 await expect(settle(query('reject',cause,true))).resolves.toMatchObject({data:null,count:null,error:{message:expect.any(String)}});
 expect(requests).toHaveLength(1);
});
it('retains the healthy sibling when an actual SDK rejection cause cannot be stringified',async()=>{
 const cause=Object.assign(Object.create(null) as Record<string,unknown>,{message:'Synthetic dictionary rejection'});
 const results=await settleAll([query('reject',cause,true),query('success')]);
 expect(results[0]).toMatchObject({data:null,count:null,error:{message:expect.any(String)}});
 expect(results[1]).toMatchObject({data:[{id:healthyId}],error:null});
 expect(requests).toHaveLength(2);
});

it('settles an SDK rejection with a throwing Error message getter', async () => {
  const cause = new Error('unreadable message');
  Object.defineProperty(cause, 'message', { get() { throw new Error('message unavailable'); } });
  await expect(settle(query('reject', cause, true))).resolves.toEqual(fallback('Query failed.'));
  expect(requests).toHaveLength(1);
});
it('keeps a healthy sibling beside an SDK rejection with a throwing message getter', async () => {
  const cause = new Error('unreadable message');
  Object.defineProperty(cause, 'message', { get() { throw new Error('message unavailable'); } });
  const results = await settleAll([query('success'), query('reject', cause, true)]);
  expect(results[0]).toMatchObject({data:[{id:healthyId}],error:null});
  expect(results[1]).toEqual(fallback('Query failed.'));
  expect(requests).toHaveLength(2);
});
it('settles an SDK rejection with a throwing primitive conversion', async () => {
  const cause = { [Symbol.toPrimitive]() { throw new Error('conversion unavailable'); } };
  await expect(settle(query('reject', cause, true))).resolves.toEqual(fallback('Query failed.'));
  expect(requests).toHaveLength(1);
});
it('settles an SDK rejection with a throwing toString method', async () => {
  const cause = { toString() { throw new Error('conversion unavailable'); } };
  await expect(settle(query('reject', cause, true))).resolves.toEqual(fallback('Query failed.'));
  expect(requests).toHaveLength(1);
});
it('settles an SDK rejection whose prototype inspection throws', async () => {
  const cause = new Proxy({}, { getPrototypeOf() { throw new Error('prototype unavailable'); } });
  await expect(settle(query('reject', cause, true))).resolves.toEqual(fallback('Query failed.'));
  expect(requests).toHaveLength(1);
});
it.each([
  ['undefined', undefined, 'undefined'],
  ['number', 42, '42'],
  ['boolean', false, 'false'],
  ['bigint', 42n, '42'],
  ['symbol', Symbol('synthetic transport'), 'Symbol(synthetic transport)'],
] as const)('preserves the existing %s rejection message through the SDK', async (_label, cause, message) => {
  expect(await settle(query('reject', cause, true))).toEqual(fallback(message));
  expect(requests).toHaveLength(1);
});
it('preserves an empty Error message through the SDK', async () => {
  expect(await settle(query('reject', new Error(''), true))).toEqual(fallback(''));
  expect(requests).toHaveLength(1);
});
it('preserves a successful custom primitive conversion through the SDK', async () => {
  const cause = { [Symbol.toPrimitive]() { return 'custom transport refusal'; } };
  expect(await settle(query('reject', cause, true))).toEqual(fallback('custom transport refusal'));
  expect(requests).toHaveLength(1);
});
it('retains two ordinary successful SDK siblings', async () => {
  const results = await settleAll([query('success'), query('success')]);
  expect(results).toHaveLength(2);
  for (const result of results) expect(result).toMatchObject({data:[{id:healthyId}],error:null});
  expect(requests).toHaveLength(2);
});
