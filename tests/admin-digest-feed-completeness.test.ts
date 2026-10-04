// Actual SDK/engine/feed/recipient reader/rendering. Only SDK transport, account
// allowlist, delivery storage and email provider are synthetic. No SQL or HTTP.
// Keeps the six desired cases from the frozen seven-case review; the seventh
// deliberately observed the old bug and remains dated private baseline evidence.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { runAdminDigestEngine } from '@/lib/admin/digest-engine-route';
import { MemoryDigestDeliveryStore } from './helpers/digest-delivery-fakes';
const h=vi.hoisted(()=>({cap:1000,feedPages:0,failPage:0,size:3,tied:false,repeatPage:0,repeatOlder:false,duplicate:false,malformed:'none',reads:[] as string[]}));
vi.mock('@/lib/constants/super-admins',()=>({superAdminEmails:()=>['synthetic-admin@synthetic.invalid']}));
vi.mock('@/lib/supabase/server',()=>({createServiceClient:()=>{throw new Error('No service construction permitted');}}));
const now=()=>new Date('2026-09-30T12:31:00.000Z');
const feedRows=()=>Array.from({length:h.size},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,kind:'family_signup',title:`Synthetic family ${i+1}`,created_at:h.tied||h.size>3?'2026-09-30T10:00:00.000Z':`2026-09-30T${String(9+i).padStart(2,'0')}:00:00.000Z`})).reverse();
beforeEach(()=>{Object.assign(h,{cap:1000,feedPages:0,failPage:0,size:3,tied:false,repeatPage:0,repeatOlder:false,duplicate:false,malformed:'none',reads:[]});vi.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>vi.restoreAllMocks());
async function execute(empty=false){
 const admin=createClient('https://synthetic.invalid','synthetic-only-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);expect(u.origin).toBe('https://synthetic.invalid');expect(init?.method??'GET').toBe('GET');h.reads.push(u.pathname);
  if(u.pathname==='/rest/v1/super_admins'){expect(u.searchParams.get('select')).toBe('email');return Response.json([]);}
  expect(u.pathname).toBe('/rest/v1/admin_notifications');expect(u.searchParams.get('select')).toBe('id,kind,title,created_at');expect(u.searchParams.get('order')).toBe('created_at.desc,id.desc');expect(u.searchParams.get('limit')).toBe('1000');expect(u.searchParams.getAll('created_at')).toEqual(['gte.2026-09-29T12:30:00.000Z','lt.2026-09-30T12:30:00.000Z']);
  h.feedPages++;if(h.feedPages===h.failPage)return new Response(JSON.stringify({message:'Synthetic later page failure'}),{status:500,headers:{'content-type':'application/json'}});
  if(h.malformed==='null')return Response.json(null);
  if(h.malformed==='object')return Response.json({unexpected:true});
  if(h.malformed==='row')return Response.json([null]);
  let available=empty?[]:feedRows();
  const cursor=u.searchParams.get('or');if(cursor&&h.feedPages!==h.repeatPage){const match=cursor.match(/^\(created_at\.lt\.(.*),and\(created_at\.eq\.(.*),id\.lt\.(.*)\)\)$/);expect(match).not.toBeNull();available=available.filter(r=>r.created_at<match![1]||(r.created_at===match![2]&&r.id<match![3]));}
  if(h.repeatOlder&&h.feedPages===2)available=[{...feedRows()[0],created_at:'2026-09-30T08:00:00.000Z'}];
  if(h.duplicate&&h.feedPages===1)available=[available[0],...available];
  return Response.json(available.slice(0,Math.min(h.cap,1000)));
 }}});
 const store=new MemoryDigestDeliveryStore(now,()=>[]);const sent:{payloadJson:string}[]=[];
 const result=await runAdminDigestEngine({admin:admin as never,store,provider:{send:async request=>{sent.push(request);return {kind:'accepted',messageId:`synthetic-receipt-${sent.length}`};}},owner:'synthetic-review-worker',now});
 return {result,store,sent,saved:await store.load('admin-digest:2026-09-30T12:30:00.000Z')};
}
describe('actual SDK admin digest feed response cap',()=>{
 it('control: uncapped three rows are counted and frozen once',async()=>{const r=await execute();expect(r.result.status).toBe(200);expect(r.result.body).toMatchObject({ok:true,total:3,complete:true});expect(r.sent).toHaveLength(1);expect(r.saved?.deliveries).toHaveLength(1);expect(JSON.parse(r.sent[0].payloadJson).subject).toContain('3 new families');});
 it.each([1,2])('cap %s cannot be treated as the complete feed',async cap=>{h.cap=cap;const r=await execute();expect(r.result.status).toBe(200);expect(r.result.body).toMatchObject({ok:true,total:3,complete:true});expect(r.sent).toHaveLength(1);expect(JSON.parse(r.sent[0].payloadJson).subject).toContain('3 new families');expect(h.feedPages).toBeGreaterThan(1);});
 it('later capped-page read failure prevents any freeze or send',async()=>{h.cap=1;h.failPage=2;const r=await execute();expect(r.result.status).toBe(502);expect(r.result.body).toMatchObject({ok:false,reason:'notification_feed_unavailable'});expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
 it('control: first-page failure refuses before freeze or send',async()=>{h.failPage=1;const r=await execute();expect(r.result.status).toBe(502);expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
 it('control: true empty feed causes no freeze or send',async()=>{const r=await execute(true);expect(r.result.status).toBe(200);expect(r.result.body).toMatchObject({total:0,sent:0});expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
 it('cap1 tied timestamps advance by stable id and prove end with an empty page',async()=>{h.cap=1;h.tied=true;const r=await execute();expect(r.result.status).toBe(200);expect(r.result.body.total).toBe(3);expect(h.feedPages).toBe(4);expect(r.sent).toHaveLength(1);});
 it('duplicate id in one page is counted once',async()=>{h.duplicate=true;const r=await execute();expect(r.result.status).toBe(200);expect(r.result.body.total).toBe(3);expect(r.sent).toHaveLength(1);});
 it('repeated nonempty page refuses before freeze or send',async()=>{h.cap=1;h.repeatPage=2;const r=await execute();expect(r.result.status).toBe(502);expect(h.feedPages).toBe(2);expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
 it('repeated known id with an older cursor refuses before freeze or send',async()=>{h.cap=1;h.repeatOlder=true;const r=await execute();expect(r.result.status).toBe(502);expect(h.feedPages).toBe(2);expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
 it('exact 20000-row ceiling remains a complete successful read',async()=>{h.size=20000;const r=await execute();expect(r.result.status).toBe(200);expect(r.result.body.total).toBe(20000);expect(h.feedPages).toBe(21);expect(r.sent).toHaveLength(1);});
 it('one row beyond the ceiling refuses before freeze or send',async()=>{h.size=20001;h.cap=500;const r=await execute();expect(r.result.status).toBe(502);expect(h.feedPages).toBe(41);expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
 it.each(['null','object','row'])('malformed %s page refuses before freeze or send',async malformed=>{h.malformed=malformed;const r=await execute();expect(r.result.status).toBe(502);expect(r.sent).toEqual([]);expect(r.saved).toBeNull();});
});
