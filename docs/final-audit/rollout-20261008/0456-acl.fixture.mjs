import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
// Fixture runner only: requires the documented fresh local container/database.
// No remote connection option, production credential lookup or workflow dispatch.
if (process.argv.length !== 2) throw new Error('The isolated fixture runner accepts no options.');
const root=fileURLToPath(new URL('../../../', import.meta.url));
const dir=root+'docs/final-audit/rollout-20261008/';
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const sql=input=>execFileSync('docker',['--host=unix:///var/run/docker.sock','exec','-i','bubaly-audit-acl-20261008','psql','-U','postgres','-d','bubaly_acl_fixture_20261008','-XAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',env,stdio:['pipe','pipe','pipe']}).trim();
const file='supabase/migrations/0456_service_only_functions_are_service_only.sql';
const migration=readFileSync(root+file,'utf8');
sql(readFileSync(dir+'0456-acl.fixture.sql','utf8'));
const signatures=['public.wallet_reserve_card_auth(uuid,uuid,bigint,text,text)','public.marketplace_place_bid_unchecked(uuid,uuid,uuid,bigint)'];
const state=()=>JSON.parse(sql(`select json_agg(json_build_object('function',fn,'anon',has_function_privilege('anon',fn,'execute'),'authenticated',has_function_privilege('authenticated',fn,'execute'),'service',has_function_privilege('service_role',fn,'execute'))) from unnest(array['${signatures.join("','")}']) fn;`));
const before=state();assert(before.every(row=>row.anon&&row.authenticated));
sql('begin;'+migration+'rollback;');assert.deepEqual(state(),before);
sql('begin;'+migration+'commit;');
const after=state();assert(after.every(row=>!row.anon&&!row.authenticated&&row.service));
sql('begin;'+migration+'commit;');assert.deepEqual(state(),after);
const calls=["public.wallet_reserve_card_auth(null::uuid,null::uuid,0::bigint,null::text,null::text)","public.marketplace_place_bid_unchecked(null::uuid,null::uuid,null::uuid,0::bigint)"];
for(const role of ['anon','authenticated'])for(const call of calls){
 let denied=false;try{sql('set role '+role+';select '+call+';');}catch(error){denied=String(error.stderr).includes('permission denied for function');}assert(denied,role+' actual call must be denied');
}
assert.equal(sql('set role service_role;select '+calls[0]+';'),'SET\nf');
assert.deepEqual(JSON.parse(sql('set role service_role;select '+calls[1]+';').split('\n').at(-1)),{fixture:true});
// A surviving inherited grant must fail the migration postcondition and roll back.
sql(`create role inherited_execution; grant inherited_execution to anon; grant execute on function ${signatures[0]} to inherited_execution;`);
const inheritedBefore=state();let refused=false;
try{sql('begin;'+migration+'commit;');}catch(error){refused=String(error.stderr).includes('0456: a client role can still execute');}
assert(refused);assert.deepEqual(state(),inheritedBefore);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(dir+'0456-acl.fixture-results.json',JSON.stringify({database:sql('select version();'),scope:'Local disposable PostgreSQL with harmless function stubs. Exact existing migration0456 tested; no real wallet/bid bodies or production functions invoked.',migration:{path:file,sha256:sha(root+file)},fixture:{path:'docs/final-audit/rollout-20261008/0456-acl.fixture.sql',sha256:sha(dir+'0456-acl.fixture.sql')},before,after,checks:{transactionRollback:true,repeatApplication:true,actualAnonAndAuthenticatedDenial:true,serviceRoleStubCalls:true,inheritedGrantRefusalAndRollback:true}},null,2)+'\n');
console.log('0456 ACL fixture passed: rollback, replay, direct calls, service controls, inherited-grant refusal.');
