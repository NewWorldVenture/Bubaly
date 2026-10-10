const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const head = 'c4142fe2aef932662ef7a5653a3c002c20dfeab6';
const ours = 'ea466ec63824cdc6ad8d78278e9709064eea53d0';
const ts = require(path.join(repo, 'node_modules/typescript'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubaly-pr970-read-review-'));
const show = (ref, file) => cp.execFileSync('git', ['show', `${ref}:${file}`], {cwd:repo, encoding:'utf8'});
const write = (file, text) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p,text); };
for (const file of ['lib/finance/recurring.ts','lib/finance/timeline.ts','lib/supabase/errors.ts']) write(file, show(head,file));
for (const file of ['bill-schedule.ts','bills.ts']) write(`ours/${file}`, show(ours,`lib/finance/${file}`));
fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
function exactFunction(file,name) {
  const source = show(head,file); write(`source/${file}`,source);
  const parsed = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let result; const visit = node => { if(ts.isFunctionDeclaration(node) && node.name?.text===name) result=node.getText(parsed); ts.forEachChild(node,visit); }; visit(parsed);
  if(!result) throw new Error(`No function ${name}`);
  return result;
}
const imports = `import { billPaidPatch, writeBillPatch, dueDayNotKeptQuestion, isDueDayNotKept } from '@/lib/finance/recurring';\nimport { describeDbError, wroteNoRows } from '@/lib/supabase/errors';\n`;
write('buttons.ts',imports + `export function manager(env:any){ const { createClient, familyId, clock, t, toastError, success, askConfirm, fmtDueDate, locale } = env;\n${exactFunction('components/finance/bills-view.tsx','markPaid')}\nreturn markPaid; }\nexport function billing(env:any){ const { createClient, familyId, clock, bills, tr, toastError, success, askConfirm, fmtDate, locale, refreshBills } = env;\n${exactFunction('components/modules/billing-module.tsx','markBillPaid')}\nreturn markBillPaid; }\n`);
write('vitest.config.mjs',`import {defineConfig} from 'vitest/config';\nexport default defineConfig({test:{environment:'node',include:['review.test.ts'],testTimeout:20000},resolve:{alias:[{find:'@/lib/finance/recurring',replacement:${JSON.stringify(path.join(root,'lib/finance/recurring.ts'))}},{find:'@/lib/finance/timeline',replacement:${JSON.stringify(path.join(root,'lib/finance/timeline.ts'))}},{find:'@/lib/supabase/errors',replacement:${JSON.stringify(path.join(root,'lib/supabase/errors.ts'))}},{find:'@',replacement:${JSON.stringify(repo)}}]}});`);
write('review.test.ts',String.raw`
import {describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {manager,billing} from './buttons';
import {billPaidPatch,writeBillPatch,isMissingDueDayColumn} from '@/lib/finance/recurring';
import {buildCashflowTimeline} from '@/lib/finance/timeline';
import {saveBillPayment} from './ours/bills';
const FAMILY='family-synthetic';
const original=(over={})=>({id:'bill-synthetic',family_id:FAMILY,name:'Synthetic rent',amount:100,due_date:'2026-02-28',due_day:31,is_recurring:true,recurrence:'monthly',status:'upcoming',category:null,autopay:false,created_by:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',...over});
function store(initial,old=false,error=null){
 let row={...initial}; const requests=[];
 const client=createClient('https://synthetic-bills.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input)); const patch=JSON.parse(String(init?.body));requests.push({url,patch});
  const e=error || (old && Object.hasOwn(patch,'due_day')?{code:'PGRST204',message:"Could not find the 'due_day' column of 'bills' in the schema cache"}:null);
  if(e)return new Response(JSON.stringify(e),{status:400,headers:{'Content-Type':'application/json'}});
  const matches=[...url.searchParams].filter(([key])=>key!=='select').every(([key,filter])=>filter==='is.null'?row[key]===null:filter==='eq.'+String(row[key]));
  if(matches)row={...row,...patch};
  return new Response(JSON.stringify(matches?[{id:row.id}]:[]),{headers:{'Content-Type':'application/json'}});
 }}});return{client,requests,current:()=>row};
}
function button(kind,db,bill,answer=true){const env={createClient:()=>db.client,familyId:FAMILY,clock:{todayKey:()=>bill.due_date},bills:[bill],t:k=>k,tr:k=>k,toastError:vi.fn(),success:vi.fn(),askConfirm:vi.fn(async()=>answer),fmtDueDate:k=>k,fmtDate:k=>k,locale:{code:'en-US'},refreshBills:vi.fn(async()=>undefined)};const invoke=kind==='manager'?manager(env):billing(env);return{env,run:()=>invoke(kind==='manager'?bill:bill.id)};}
for(const kind of ['manager','billing'])describe('Exact '+kind+' source callback, c4142fe2',()=>{
 it('blocks a stale payment after another writer corrects due_day without changing date or cadence',async()=>{
  const seen=original(),corrected=original({due_day:29,updated_at:'2026-02-20T00:00:00Z'}),db=store(corrected),b=button(kind,db,seen);
  await b.run();console.log(kind+' anchor correction witness',JSON.stringify({row:db.current(),filters:Object.fromEntries(db.requests[0].url.searchParams),success:b.env.success.mock.calls}));
  expect(db.current()).toEqual(corrected);expect(b.env.success).not.toHaveBeenCalled();expect(b.env.toastError).toHaveBeenCalled();
 });
 it('marks a non-recurring row paid even when an old cadence string remains',async()=>{
  const seen=original({is_recurring:false,recurrence:'monthly'}),db=store(seen),b=button(kind,db,seen);await b.run();
  console.log(kind+' one-off witness',JSON.stringify(db.current()));expect(db.current()).toMatchObject({status:'paid',due_date:seen.due_date});
 });
 it('confirmed clamp still matches current due date and cadence; changed row is rejected',async()=>{
  const seen=original({due_date:'2026-01-31',due_day:31}),db=store({...seen,due_date:'2026-02-28'},true),b=button(kind,db,seen);await b.run();
  expect(b.env.askConfirm).toHaveBeenCalledTimes(1);expect(db.current().due_date).toBe('2026-02-28');expect(b.env.success).not.toHaveBeenCalled();expect(b.env.toastError).toHaveBeenCalled();
 });
 it('declined clamp is left unchanged and an RLS refusal is not retried',async()=>{
  const seen=original({due_date:'2026-01-31'}),db=store(seen,true),b=button(kind,db,seen,false);await b.run();expect(db.current()).toEqual(seen);expect(db.requests).toHaveLength(1);expect(b.env.success).not.toHaveBeenCalled();
  const denied=store(seen,false,{code:'42501',message:'write denied'}),d=button(kind,denied,seen);await d.run();expect(denied.requests).toHaveLength(1);expect(d.env.askConfirm).not.toHaveBeenCalled();
 });
});
describe('Current969 comparison and forecast coherence',()=>{
 it('current969 rejects the same corrected-anchor stale occurrence',async()=>{const seen=original(),corrected=original({due_day:29,updated_at:'2026-02-20T00:00:00Z'}),db=store(corrected);const r=await saveBillPayment(db.client,FAMILY,seen,seen.due_date);expect(r.data).toEqual([]);expect(db.current()).toEqual(corrected);});
 it('current969 pays non-recurring row with retained cadence as one-off',async()=>{const seen=original({is_recurring:false}),db=store(seen);await saveBillPayment(db.client,FAMILY,seen,seen.due_date);expect(db.current()).toMatchObject({status:'paid',due_date:seen.due_date});});
 it('a true/null cadence defaults monthly for payment but does not recur in its own forecast',()=>{const seen=original({due_date:'2026-01-15',due_day:15,recurrence:null});const patch=billPaidPatch(seen,seen.due_date);const paid={...seen,...patch};const dates=buildCashflowTimeline({bills:[paid],goals:[],events:[],startingBalance:1000,now:new Date('2026-02-01T12:00:00Z'),horizonWeeks:12}).weeks.flatMap(w=>w.moments).map(m=>m.date);console.log('missing cadence witness',JSON.stringify({patch,dates}));expect(dates).toContain('2026-03-15');});
 it('a normalized named cadence is consistent between payment and forecast',()=>{const seen=original({due_date:'2026-01-15',due_day:15,recurrence:' Monthly '});const patch=billPaidPatch(seen,seen.due_date);const paid={...seen,...patch};const dates=buildCashflowTimeline({bills:[paid],goals:[],events:[],startingBalance:1000,now:new Date('2026-02-01T12:00:00Z'),horizonWeeks:12}).weeks.flatMap(w=>w.moments).map(m=>m.date);console.log('normalized cadence witness',JSON.stringify({patch,dates}));expect(dates).toContain('2026-03-15');});
 it('only a missing exact due_day column can activate the old-schema retry',()=>{for(const error of [{code:'PGRST204',message:"Could not find the 'due_day_backup' column of 'bills' in the schema cache"},{code:'42P01',message:'relation "due_day_history" does not exist'},{code:'42501',message:'permission denied by due_day schema cache guard'}]){console.log('fallback predicate witness',JSON.stringify({error,retry:isMissingDueDayColumn(error)}));expect(isMissingDueDayColumn(error)).toBe(false);}});
});
`);
const run=cp.spawnSync(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(root,'vitest.config.mjs'),'--reporter=verbose'],{cwd:root,encoding:'utf8',timeout:60000});
fs.writeFileSync(path.join(root,'receipt.log'),run.stdout+run.stderr);console.log(root);console.log(run.stdout+run.stderr);console.log('exit',run.status);process.exitCode=run.status||0;
