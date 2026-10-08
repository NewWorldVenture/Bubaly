// Synthetic PostgreSQL only: creates and stops its OWN disposable local cluster.
// node scripts/verify-calendar-feed-publication.mjs --bin "C:/Program Files/PostgreSQL/17/bin"
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),opts={};
assert(args.length>0 && args.length%2===0,'Arguments must be explicit option/value pairs.');
for(let i=0;i<args.length;i+=2){assert(args[i].startsWith('--') && args[i+1] && !args[i+1].startsWith('--'),'Invalid option/value pair');const key=args[i].slice(2);assert(!Object.hasOwn(opts,key),'Duplicate option');opts[key]=args[i+1];}
const own=Boolean(opts.bin),bin=opts.bin??opts['postgres-bin'],suffix=process.platform==='win32'?'.exe':'';
assert(!own || Object.keys(opts).length===1,'Standalone --bin cannot be mixed with connection arguments.');
assert(own || /^\d{1,5}$/.test(opts['expected-server-port']??''),'External disposable server requires explicit --expected-server-port.');
assert(isAbsolute(bin??'') && (own || (isAbsolute(opts['expected-data-dir']??'') && /^\d{1,5}$/.test(opts.port??''))),'Explicit --bin or --postgres-bin --port --expected-data-dir required; no connection URL accepted.');
assert(Object.keys(opts).every(k=>['bin','postgres-bin','port','expected-server-port','expected-data-dir'].includes(k)),'Unknown argument');
const work=mkdtempSync(join(tmpdir(),'bubaly-feed-publication-')),data=own?join(work,'data'):opts['expected-data-dir'],port=own?55443:Number(opts.port);
assert(port>0 && port<=65535,'Invalid local port');
const database='synthetic_feed_'+randomUUID().replaceAll('-','');
const migration='supabase/reserved/0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql';
const migrationHash=createHash('sha256').update(readFileSync(join(root,migration))).digest('hex');
const base=['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,'-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
const admin=base.map(x=>x===database?'postgres':x);
// Preserve only an explicitly supplied synthetic password. Never inherit
// libpq connection aliases, service files or option overrides.
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('PG') || key==='PGPASSWORD'));
Object.assign(childEnv,{PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'5'});
function run(name,args,input){return execFileSync(join(bin,name+suffix),args,{cwd:root,input,env:childEnv,encoding:'utf8',timeout:30000,stdio:name==='pg_ctl'?'ignore':['pipe','pipe','pipe']});}
const sql=text=>run('psql',base,text).trim();
const file=p=>run('psql',[...base,'-f',join(root,p)]);
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const rows=r=>q(JSON.stringify(r))+'::jsonb';
const feed='11111111-1111-4111-8111-111111111111',family='22222222-2222-4222-8222-222222222222';
const other='33333333-3333-4333-8333-333333333333',otherFamily='44444444-4444-4444-8444-444444444444';
const user='55555555-5555-4555-8555-555555555555';
const stamp='2026-10-07T10:00:00Z';
const revision={sequence:1,dtstamp:'20261007T100000Z',lastModified:null,etag:null};
const component=uid=>({uid,title:'New',description:null,location:null,status:'confirmed',dtstart:{kind:'utc',value:'20261008T090000Z'},end:{kind:'default'},rrule:'FREQ=WEEKLY',rdates:[],exdates:[],revision,raw:null});
const document=uid=>({version:1,uid,master:component(uid),overrides:[],timezones:[],revision,rawProperties:[]});
const row=(uid,extra={})=>({external_uid:uid,title:'New',starts_at:'2026-10-08T09:00:00Z',ends_at:null,all_day:false,recurrence:Object.hasOwn(extra,'source_recurrence')?'none':'weekly',category:'general',...extra});
const call=(r,rem=[],fn='calendar_feed_publish_snapshot',f=feed,s=stamp)=>`select public.${fn}(${q(f)},${q(s)},${rows(r)},array[${rem.map(q).join(',')}]::text[]);`;
const auth=text=>`set role authenticated; set request.jwt.claim.sub=${q(user)}; ${text}`;
let checks=0,started=false,created=false;
const checkLabels=[];
function check(label,work){work();checks++;checkLabels.push(label);console.log('PASS '+label);}
function failure(text,state='22023'){
 let err;try{sql(text);}catch(e){err=e;}
 assert(err && err.status!==0 && !err.code,'Expected SQL refusal, not success/timeout.');
 assert.match(String(err.stderr),new RegExp('ERROR:\\s+'+state+':'));
}
function seed(){
 sql(`truncate calendar_events,calendar_feeds,family_members,families,auth.users cascade;
 insert into auth.users(id,email) values(${q(user)},'fixture@example.invalid');
 insert into families(id,name,created_by) values(${q(family)},'A',${q(user)}),(${q(otherFamily)},'B',${q(user)});
 insert into family_members(family_id,user_id,display_name,role) values(${q(family)},${q(user)},'A','parent'),(${q(otherFamily)},${q(user)},'B','parent') on conflict do nothing;
 insert into calendar_feeds(id,family_id,name,url,last_status,updated_at) values(${q(feed)},${q(family)},'A','https://fixture.invalid/a','syncing',${q(stamp)}),(${q(other)},${q(otherFamily)},'B','https://fixture.invalid/b','syncing',${q(stamp)});
 insert into calendar_events(family_id,feed_id,external_uid,title,starts_at,description) values(${q(family)},${q(feed)},'old','Old','2026-10-08T09:00Z','Keep'),(${q(family)},${q(feed)},'history','History','2026-10-08T09:00Z',null),(${q(otherFamily)},${q(other)},'old','Other','2026-10-08T09:00Z',null);`);
}
const state=()=>sql("select md5(jsonb_build_object('events',(select jsonb_agg(to_jsonb(e) order by id) from calendar_events e),'feeds',(select jsonb_agg(to_jsonb(f) order by id) from calendar_feeds f),'revisions',(select jsonb_agg(to_jsonb(r) order by id) from calendar_feed_source_revisions r),'groups',(select jsonb_agg(to_jsonb(g) order by feed_id,external_uid) from calendar_feed_source_groups g),'watermarks',(select jsonb_agg(to_jsonb(w) order by feed_id,external_uid,component_key) from calendar_feed_source_component_watermarks w))::text);");
const archive=(docs,f=feed,s=stamp)=>`select public.calendar_feed_archive_sources(${q(f)},${q(s)},${rows(docs)});`;
const arm=()=>{sql(`update calendar_feeds set last_status='syncing' where id=${q(feed)};`);return sql(`select updated_at from calendar_feeds where id=${q(feed)};`);};
const versioned=(sequence,status='confirmed')=>{const d=document('old');d.master={...d.master,status,revision:{...revision,sequence}};d.revision=d.master.revision;if(status==='cancelled')Object.assign(d.master,{dtstart:null,end:null,rrule:null});return d;};
const detached=sequence=>{const d=document('old');return {...d,master:null,revision:{sequence:null,dtstamp:null,lastModified:null,etag:null},overrides:[{...component('old'),revision:{...revision,sequence},recurrenceId:{kind:'utc',value:'20261008T090000Z'},range:'none'}]};};
const children=new Set();
function session(){
 const app='feed-fixture-'+randomUUID();const child=spawn(join(bin,'psql'+suffix),base,{cwd:root,env:{...childEnv,PGAPPNAME:app},stdio:['pipe','pipe','pipe']});
 children.add(child);let out='',err='',pending;
 child.stdout.on('data',b=>{out+=b;if(pending && out.includes(pending.marker)){const p=pending;pending=null;clearTimeout(p.timer);p.resolve(out);}});
 child.stderr.on('data',b=>{err+=b;});
 const done=new Promise(resolve=>child.on('close',code=>{children.delete(child);if(pending){clearTimeout(pending.timer);pending.reject(new Error(err));pending=null;}resolve({code,out,err});}));
 return {app,child,done,send(text){return new Promise((resolve,reject)=>{const marker='MARK'+randomUUID().replaceAll('-','');pending={marker,resolve,reject,timer:setTimeout(()=>reject(new Error('Session timeout '+err)),15000)};child.stdin.write(text+'\n\\echo '+marker+'\n');});},end(){child.stdin.end();}};
}
async function waitFor(app,predicate){
 for(let i=0;i<100;i++){if(sql(`select count(*) from pg_stat_activity where application_name=${q(app)} and (${predicate});`)==='1')return;await new Promise(r=>setTimeout(r,30));}
 throw new Error('Backend did not reach '+predicate);
}
try{
 if(own){
 await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen({host:'127.0.0.1',port,exclusive:true},()=>probe.close(err=>err?reject(err):resolve()));});
 run('initdb',['-D',data,'-U','postgres','--auth=trust','--encoding=UTF8','--locale=C']);
 run('pg_ctl',['-D',data,'-l',join(work,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}${process.platform==='win32'?'':" -c unix_socket_directories=''"}`,'-w','start']);started=true;}
 const identity=run('psql',[...admin,'-c','show data_directory; show port; show server_version_num; select session_user;']).trim();
 assert.equal(resolve(identity.split(/\r?\n/)[0]).toLowerCase(),resolve(data).toLowerCase());assert.equal(identity.split(/\r?\n/)[1],opts['expected-server-port']??String(port));
 assert.match(identity.split(/\r?\n/)[2],/^17\d{4}$/);assert.equal(identity.split(/\r?\n/)[3],'postgres');
 if(own){
  for(const mismatch of ['port','directory'])check('external CLI refuses wrong '+mismatch+' before database creation',()=>{
   const before=run('psql',[...admin,'-c',"select string_agg(datname,',' order by datname) from pg_database;"]);
   let rejected;try{execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--postgres-bin',bin,'--port',String(port),'--expected-server-port',String(mismatch==='port'?port+1:port),'--expected-data-dir',mismatch==='directory'?join(work,'wrong-data'):data],{cwd:root,env:childEnv,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});}catch(e){rejected=e;}
   assert(rejected && rejected.status!==0 && !rejected.code);assert.match(String(rejected.stderr),/AssertionError/);
   assert.equal(run('psql',[...admin,'-c',"select string_agg(datname,',' order by datname) from pg_database;"]),before);
  });
 }
 run('psql',[...admin,'-c',`create database "${database}" template template0;`]);created=true;
 const bootstrap=readFileSync(join(root,'docs/audit/pg-bootstrap.sh'),'utf8').match(/psql[^\r\n]*<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/);assert(bootstrap);sql(bootstrap[1]);
 for(const p of ['0001_extensions_enums.sql','0002_tables.sql','0003_functions_triggers.sql','0004_rls.sql','0045_calendar_feeds.sql'])file('supabase/migrations/'+p);
 // Use the actual production unique-index statement, not a substitute target.
 const target=readFileSync(join(root,'supabase/migrations/0285_conflict_targets_inferable.sql'),'utf8');
 sql(target.match(/create unique index if not exists uq_calendar_events_feed_uid[\s\S]*?;/i)[0]);
 sql('grant usage on schema public,auth to authenticated,service_role; grant all on all tables in schema public to authenticated,service_role;');
 file(migration);file(migration); // idempotence
 file('docs/audit/reserved/a-calendar-feed-sync-writes-only-while-it-holds-its-claim-check.sql');
 check('legacy held probe and idempotent DDL',()=>{});
 seed();
 check('legacy chunks do not settle and only delete exact feed keys',()=>{
  assert.equal(sql(auth(call([row('old')],['history'],'calendar_feed_apply_sync'))),'applied');
  assert.equal(sql(`select last_status from calendar_feeds where id=${q(feed)};`),'syncing');
  assert.equal(sql(`select title from calendar_events where feed_id=${q(other)} and external_uid='old';`),'Other');
 });
 seed();
 check('whole publication persists source and retains absent UID history',()=>{
  assert.equal(sql(auth(call([row('old',{source_recurrence:document('old')})]))),'applied');
  assert.equal(sql(`select event_count||':'||last_status from calendar_feeds where id=${q(feed)};`),'2:ok');
  assert.equal(sql(`select source_recurrence->>'uid' from calendar_events where feed_id=${q(feed)} and external_uid='old';`),'old');
 });
 const invalids=[
  row('old',{source_recurrence:{...document('old'),version:2}}),
  row('old',{source_recurrence:document('cross')}),
  row('old',{source_recurrence:{...document('old'),master:{...component('cross')}}}),
  row('old',{source_recurrence:{...document('old'),master:{...component('old'),dtstart:null}}}),
  row('old',{source_recurrence:null}),row('old',{source_recurrence:{...document('old'),unknown:true}}),
  row('old',{source_recurrence:{...document('old'),revision:{...revision,sequence:-1}}}),
  row('old',{source_recurrence:document('old'),title:'Conflict'}),
  row('old',{source_recurrence:document('old'),all_day:true}),
  row('old',{source_recurrence:document('old'),starts_at:'2026-10-08T10:00:00Z'}),
  row('old',{source_recurrence:document('old'),ends_at:'2026-10-08T10:00:00Z'}),
  row('old',{source_recurrence:document('old'),recurrence:'weekly'}),
  row('old',{source_recurrence:{...document('old'),master:{...component('old'),dtstart:{kind:'zoned',value:'20261008T090000',tzid:'America/New_York'}}}}),
  row('old',{source_recurrence:{...document('old'),master:{...component('old'),dtstart:{kind:'floating',value:'20261008T090000'}}}}),
  row('old',{source_recurrence:document('old'),ends_at:undefined}),
 ];
 for(const [i,bad] of invalids.entries())check('invalid late row rolls back whole publication '+i,()=>{
  seed();const before=state();failure(auth(call([row('first'),bad],['history'])));assert.equal(state(),before);
 });
 for(const field of ['id','created_at','updated_at','created_by','assignee_id','no_such_column'])check('forbidden projection '+field,()=>{seed();const before=state();failure(auth(call([row('old',{[field]:field==='id'?feed:stamp})])),'42703');assert.equal(state(),before);});
 check('multi-family member cannot cross-label feed rows',()=>{seed();const before=state();failure(auth(call([row('old',{family_id:otherFamily})])),'42501');assert.equal(state(),before);});
 check('stale claim is lost without fence/status/event writes',()=>{seed();const before=state();assert.equal(sql(auth(call([row('old')],['history'],'calendar_feed_publish_snapshot',feed,'2026-10-06T10:00Z'))),'lost');assert.equal(state(),before);});
 check('source omission over existing document refuses',()=>{seed();sql(call([row('old',{source_recurrence:document('old')})],[],'calendar_feed_apply_sync'));const before=state();failure(call([row('old')]));assert.equal(state(),before);});
 check('heterogeneous legacy fields retain another row omitted description',()=>{seed();sql(call([row('old'),row('second',{description:'Second'})],[],'calendar_feed_apply_sync'));assert.equal(sql(`select description from calendar_events where feed_id=${q(feed)} and external_uid='old';`),'Keep');});
 check('DATE default end and exact UTC/DATE ends project completely',()=>{
  seed();
  for(const [uid,start,end,starts,ends,allDay] of [
   ['date',{kind:'date',value:'20261008'},{kind:'default'},'2026-10-08T00:00Z','2026-10-09T00:00Z',true],
   ['date-end',{kind:'date',value:'20261008'},{kind:'dtend',value:{kind:'date',value:'20261010'}},'2026-10-08T00:00Z','2026-10-10T00:00Z',true],
   ['utc-end',{kind:'utc',value:'20261008T090000Z'},{kind:'dtend',value:{kind:'utc',value:'20261008T110000Z'}},'2026-10-08T09:00Z','2026-10-08T11:00Z',false],
  ]){const d={...document(uid),master:{...component(uid),dtstart:start,end}};assert.equal(sql(call([row(uid,{source_recurrence:d,starts_at:starts,ends_at:ends,all_day:allDay})],[],'calendar_feed_apply_sync')),'applied');}
  assert.equal(sql(`select count(*) from calendar_events where feed_id=${q(feed)} and source_recurrence is not null;`),'3');
 });
 check('positive mixed-case plus duration validates structurally but unqualified projection refuses',()=>{seed();const d={...document('old'),master:{...component('old'),end:{kind:'duration',value:'+pt3h'}}};sql(`select calendar_feed_private.validate_value(${rows(d)},'document','old');`);failure(call([row('old',{source_recurrence:d})]));});
 check('oversized source and bounded whole payload refuse atomically',()=>{
  seed();const before=state();failure(call([row('old',{source_recurrence:{...document('old'),rawProperties:['x'.repeat(1048577)]}})]));assert.equal(state(),before);
  failure(call(Array.from({length:2001},(_,i)=>row('x'+i))));assert.equal(state(),before);
 });
 check('invoker ACL denies anonymous execution',()=>{
  assert.equal(sql("select has_function_privilege('anon','public.calendar_feed_publish_snapshot(uuid,timestamptz,jsonb,text[])','EXECUTE');"),'f');
  assert.equal(sql("select bool_and(not prosecdef) from pg_proc where proname in ('calendar_feed_apply_sync','calendar_feed_publish_snapshot');"),'t');
 });
 check('raw CRLF source and escaped parameterized timezone identity retained',()=>{
  seed();const d={...document('old'),rawProperties:['VERSION:2.0\r\n','PRODID:Fixture\r\n'],master:{...component('old'),raw:'BEGIN:VEVENT\r\nUID:old\r\nDTSTART:20261008T090000Z\r\nEND:VEVENT\r\n'},timezones:[{tzid:'Publisher,Custom',raw:'BEGIN:VTIMEZONE\r\nTZID;X-LABEL="a:b":Publisher\\,Custom\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n'}]};
  sql(call([row('old',{source_recurrence:d})]));
  const before=state();failure(`select calendar_feed_private.validate_value(${rows({...d,rawProperties:['PRODID:Bad\r']})},'document','old');`);assert.equal(state(),before);
 });
 check('JSONB decoder rejects NUL and unpaired surrogates before publication',()=>{
  seed();const before=state();
  failure(`select ${rows({text:'\u0000'})};`,'22P05');
  for(const text of ['\ud800','\udfff'])failure(`select ${rows({text})};`,'22P02');
  assert.equal(state(),before);
 });
 check('valid Unicode surrogate pair survives source storage',()=>{
  seed();const title='Family \u{1f468}\u{1f3fd}';const d={...document('old'),master:{...component('old'),title}};
  sql(call([row('old',{title,source_recurrence:d})]));
  assert.equal(sql(`select source_recurrence->'master'->>'title' from calendar_events where feed_id=${q(feed)} and external_uid='old';`),title);
 });
 check('incompatible pre-existing column type/nullability/default refuse and rollback',()=>{
  seed();const before=state(),ddl=readFileSync(join(root,migration),'utf8');
  for(const change of ["alter table calendar_events alter column source_recurrence type text using source_recurrence::text;","truncate calendar_events; alter table calendar_events alter column source_recurrence set not null;","alter table calendar_events alter column source_recurrence set default '{}'::jsonb;"]){failure('begin; '+change+ddl,'P0001');assert.equal(state(),before);}
 });
 check('archive accepts live cancellation and detached-only groups without sentinel rows',()=>{
  seed();const a=JSON.parse(sql(auth(archive([versioned(1)]))));assert.equal(a.outcome,'applied');
  assert.equal(sql(`select string_agg(external_uid,',' order by external_uid) from calendar_events where feed_id=${q(feed)};`),'history');
  assert.equal(sql(`select event_count from calendar_feeds where id=${q(feed)};`),'1');
  assert.equal(JSON.parse(sql(auth(archive([versioned(2,'cancelled')],feed,arm())))).outcome,'applied');
  const d=detached(900);const out=JSON.parse(sql(auth(archive([d],feed,arm()))));assert.equal(out.outcome,'needs_revision_review');
  assert.equal(out.groups[0].state,'needs_revision_review');
  assert.equal(sql(`select document->'master' from calendar_feed_source_revisions where id=${q(out.groups[0].revision_id)};`),'null');
  assert.equal(sql(`select count(*) from calendar_feed_source_revisions where feed_id=${q(feed)};`),'3');
  assert.equal(sql(`select last_status from calendar_feeds where id=${q(feed)};`),'revision_review');
  assert.equal(sql(`select master_cancellation_revision_id is not null from calendar_feed_source_groups where feed_id=${q(feed)};`),'t');
 });
 check('comparable newer live master clears cancellation; identical current archive reuses revision',()=>{
  seed();sql(auth(archive([versioned(2,'cancelled')])));
  const d=versioned(3);const out=JSON.parse(sql(auth(archive([d],feed,arm()))));assert.equal(out.outcome,'applied');
  assert.equal(sql(`select master_cancellation_revision_id is null from calendar_feed_source_groups where feed_id=${q(feed)};`),'t');
  const again=JSON.parse(sql(auth(archive([d],feed,arm()))));assert.equal(again.groups[0].reused,true);assert.equal(again.groups[0].revision_id,out.groups[0].revision_id);
  assert.equal(sql(`select count(*) from calendar_feed_source_revisions;`),'2');
 });
 check('persistent live watermark refuses older master after unversioned and detached replacements',()=>{
  for(const replacement of [{...versioned(5),master:{...versioned(5).master,revision:{sequence:null,dtstamp:null,lastModified:null,etag:'opaque-new'}}},detached(999)]){
   seed();sql(auth(archive([versioned(5)])));assert.equal(JSON.parse(sql(auth(archive([replacement],feed,arm())))).outcome,'needs_revision_review');
   const fence=arm(),before=state();failure(auth(archive([versioned(4)],feed,fence)));assert.equal(state(),before);
   assert.equal(sql(`select version_component->'revision'->>'sequence' from calendar_feed_source_component_watermarks where component_key='master';`),'5');
  }
 });
 check('cancelled master and detached component revisions never share ordering',()=>{
  seed();sql(auth(archive([versioned(5,'cancelled')])));const d=detached(1000);
  assert.equal(JSON.parse(sql(auth(archive([d],feed,arm())))).outcome,'needs_revision_review');
  const f=arm(),before=state();failure(auth(archive([versioned(4)],feed,f)));assert.equal(state(),before);
 });
 check('detached cancellation watermark survives omitted original identities',()=>{
  seed();const d=detached(5);d.overrides[0].status='cancelled';sql(auth(archive([d])));
  const another=detached(9);another.overrides[0].recurrenceId.value='20261015T090000Z';sql(auth(archive([another],feed,arm())));
  const old=detached(4),f=arm(),before=state();failure(auth(archive([old],feed,f)));assert.equal(state(),before);
 });
 check('source revision stamps order same-component ties; opaque ETags never order',()=>{
  seed();const d=versioned(5);d.master.revision.dtstamp='20261008T100000Z';sql(auth(archive([d])));
  let f=arm(),before=state();failure(auth(archive([versioned(5)],feed,f)));assert.equal(state(),before);
  const unknown=versioned(5);unknown.master.revision={sequence:null,dtstamp:null,lastModified:null,etag:'zzzz'};
  assert.equal(JSON.parse(sql(auth(archive([unknown],feed,f)))).outcome,'needs_revision_review');
  f=arm();before=state();failure(auth(archive([versioned(4)],feed,f)));assert.equal(state(),before);
 });
 check('archive validates late rows atomically and stale transport fences do not publish',()=>{
  seed();const before=state();failure(auth(archive([versioned(1),{...document('z-late'),master:null,overrides:[]}])));assert.equal(state(),before);
  assert.equal(JSON.parse(sql(auth(archive([versioned(1)],feed,'2020-01-01T00:00Z')))).outcome,'lost');assert.equal(state(),before);
 });
 check('archive refuses corrupt foreign-family feed references for members and service',()=>{
  seed();sql(`update calendar_events set family_id=${q(otherFamily)} where feed_id=${q(feed)} and external_uid='old';`);const before=state();
  failure(auth(archive([versioned(1)])),'42501');assert.equal(state(),before);
  failure(`set role service_role; ${archive([versioned(1)])}`,'42501');assert.equal(state(),before);
  assert.equal(sql(`select count(*) from calendar_events where feed_id=${q(feed)} and family_id=${q(otherFamily)};`),'1');
 });
 check('bounded historical component identities refuse overflow without forgetting watermarks',()=>{
  seed();sql(auth(archive([versioned(5)])));
  sql(`insert into calendar_feed_source_component_watermarks(feed_id,external_uid,component_key,version_component,version_revision_id)
    select feed_id,external_uid,'fixture-'||n,document->'master',id from calendar_feed_source_revisions cross join generate_series(1,19999) n;`);
  const f=arm(),before=state();failure(auth(archive([detached(6)],feed,f)));assert.equal(state(),before);
  assert.equal(sql('select count(*) from calendar_feed_source_component_watermarks;'),'20000');
 });
 check('archive actual SQL role membership and explicit service policy are independent',()=>{
  seed();const before=state();failure(archive([versioned(1)]),'42501');assert.equal(state(),before);
  sql(`update family_members set is_active=false where family_id=${q(family)};`);
  failure(auth(`set request.jwt.claim.role='service_role'; ${archive([versioned(1)])}`),'42501');
  failure("set session authorization authenticated; set role authenticated; set role service_role;",'42501');
  failure(`set role authenticated; set request.jwt.claim.sub=''; ${archive([versioned(1)])}`,'42501');
  assert.equal(JSON.parse(sql(`set role service_role; ${archive([versioned(1)])}`)).outcome,'applied');
 });
 check('archive tables have read-only grants and immutable revisions',()=>{
  for(const table of ['calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks'])for(const role of ['authenticated','service_role']){
   assert.equal(sql(`select has_table_privilege(${q(role)},${q(table)},'INSERT,UPDATE,DELETE,TRUNCATE');`),'f');
  }
  failure(auth('delete from calendar_feed_source_revisions;'),'42501');
  failure('update calendar_feed_source_revisions set document=document;','42501');
  assert.equal(sql("select has_function_privilege('anon','public.calendar_feed_archive_sources(uuid,timestamptz,jsonb)','EXECUTE');"),'f');
 });
 check('leavers lose immutable archive group and watermark reads immediately',()=>{
  seed();sql(auth(archive([versioned(1)])));
  assert.equal(sql(auth('select count(*) from calendar_feed_source_revisions;')),'1');
  sql(`update family_members set is_active=false where family_id=${q(family)};`);
  for(const table of ['calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks'])assert.equal(sql(auth(`select count(*) from ${table};`)),'0');
 });
 check('dual-family member and service cannot transfer archived history by reparenting',()=>{
  seed();sql(auth(archive([versioned(1)])));const before=state();
  failure(auth(`update calendar_feeds set family_id=${q(otherFamily)} where id=${q(feed)};`),'42501');assert.equal(state(),before);
  failure(`set role service_role; update calendar_feeds set family_id=${q(otherFamily)} where id=${q(feed)};`,'42501');assert.equal(state(),before);
  const reader='66666666-6666-4666-8666-666666666666';sql(`insert into auth.users(id,email) values(${q(reader)},'b-only@example.invalid'); insert into family_members(family_id,user_id,display_name,role) values(${q(otherFamily)},${q(reader)},'B-only','parent');`);
  for(const table of ['calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks'])assert.equal(sql(`set role authenticated; set request.jwt.claim.sub=${q(reader)}; select count(*) from ${table};`),'0');
  sql(auth(`update calendar_feeds set name='Allowed ordinary edit' where id=${q(feed)};`));
  assert.equal(sql(`select name from calendar_feeds where id=${q(feed)};`),'Allowed ordinary edit');
 });
 check('archive composite pointers refuse another feed or UID revision',()=>{
  seed();sql(auth(archive([versioned(1)])));sql(auth(archive([document('other-uid')],other)));
  const id=sql(`select id from calendar_feed_source_revisions where feed_id=${q(other)};`),before=state();
  failure(`update calendar_feed_source_groups set current_revision_id=${q(id)} where feed_id=${q(feed)};`,'23503');assert.equal(state(),before);
  const another=document('second');sql(auth(archive([another],feed,arm())));const wrong=sql("select id from calendar_feed_source_revisions where external_uid='second';");
  failure(`update calendar_feed_source_groups set master_cancellation_revision_id=${q(wrong)} where external_uid='old';`,'23503');
 });
 check('archive DDL replay preserves current pointer and immutable history',()=>{const before=state();file(migration);assert.equal(state(),before);});
 seed();
 sql("create function public.fixture_archive_pause() returns trigger language plpgsql as $$begin if new.external_uid='z-pause' then perform pg_sleep(20); end if; return new; end$$;create trigger fixture_archive_pause after insert on calendar_feed_source_revisions for each row execute function public.fixture_archive_pause();");
 const archiveCancel=session(),archiveBefore=state();const cancelledArchive=archiveCancel.send(auth(archive([versioned(1),document('z-pause')]))).then(()=>{throw new Error('Expected archive cancellation');},()=>{});
 await waitFor(archiveCancel.app,"wait_event='PgSleep'");sql(`select pg_cancel_backend(pid) from pg_stat_activity where application_name=${q(archiveCancel.app)};`);
 await cancelledArchive;archiveCancel.end();const archiveCancelResult=await archiveCancel.done;
 check('cancelled archive statement rolls back earlier revisions pointers retirement and settlement',()=>{assert.match(archiveCancelResult.err,/57014/);assert.equal(state(),archiveBefore);});
 sql('drop trigger fixture_archive_pause on calendar_feed_source_revisions;drop function public.fixture_archive_pause();');
 seed();const archiveOwner=session();await archiveOwner.send('begin; '+auth(archive([versioned(1)])));
 const moving=session(),movingWork=moving.send(auth(`update calendar_feeds set family_id=${q(otherFamily)} where id=${q(feed)};`)).then(()=>{throw new Error('Expected archive transfer refusal');},()=>{});
 await waitFor(moving.app,"wait_event_type='Lock'");await archiveOwner.send('commit;');archiveOwner.end();await archiveOwner.done;await movingWork;moving.end();const movingResult=await moving.done;
 check('reparent waiting behind archive commit refuses private history transfer',()=>{assert.match(movingResult.err,/42501/);assert.equal(sql(`select family_id from calendar_feeds where id=${q(feed)};`),family);assert.equal(sql('select count(*) from calendar_feed_source_revisions;'),'1');});
 seed();const mover=session();await mover.send('begin; '+auth(`update calendar_feeds set family_id=${q(otherFamily)} where id=${q(feed)};`));
 const afterMove=session(),afterMoveWork=afterMove.send(auth(archive([versioned(1)])));await waitFor(afterMove.app,"wait_event_type='Lock'");
 await mover.send('commit;');mover.end();await mover.done;await afterMoveWork;afterMove.end();const afterMoveResult=await afterMove.done;
 check('reparent before archive invalidates original feed claim without moving history',()=>{assert.match(afterMoveResult.out,/lost/);assert.equal(sql('select count(*) from calendar_feed_source_revisions;'),'0');});
 seed();
 const archiveWriter=session();await archiveWriter.send('begin; '+auth(archive([versioned(1)])));
 check('archive readers see no partial revisions pointers or settlement before commit',()=>{
  assert.equal(sql('select count(*) from calendar_feed_source_revisions;'),'0');assert.equal(sql('select count(*) from calendar_feed_source_groups;'),'0');
  assert.equal(sql(`select last_status from calendar_feeds where id=${q(feed)};`),'syncing');
 });
 const leave=session(),leaving=leave.send(`update family_members set is_active=false where family_id=${q(family)} and user_id=${q(user)};`);
 await waitFor(leave.app,"wait_event_type='Lock'");await archiveWriter.send('commit;');archiveWriter.end();await archiveWriter.done;await leaving;leave.end();await leave.done;
 check('membership deactivation waits for authorized archive then revokes history access',()=>assert.equal(sql(auth('select count(*) from calendar_feed_source_revisions;')),'0'));
 seed();const deleteFirst=session();await deleteFirst.send(`begin; select id from families where id=${q(family)} for update;`);
 const archiveBlocked=session(),archiveWaiting=archiveBlocked.send(auth(archive([versioned(1)])));
 await waitFor(archiveBlocked.app,"wait_event_type='Lock'");await deleteFirst.send(`delete from families where id=${q(family)};commit;`);deleteFirst.end();await deleteFirst.done;
 await archiveWaiting;archiveBlocked.end();const archiveLost=await archiveBlocked.done;
 check('archive parent deletion before publication returns lost without sentinel or history',()=>{assert.match(archiveLost.out,/lost/);assert.equal(sql('select count(*) from calendar_feed_source_revisions;'),'0');});
 seed();const archiveFirst=session();await archiveFirst.send('begin; '+auth(archive([versioned(1)])));
 const afterArchive=session(),afterDelete=afterArchive.send(`delete from families where id=${q(family)};`);await waitFor(afterArchive.app,"wait_event_type='Lock'");
 await archiveFirst.send('commit;');archiveFirst.end();await archiveFirst.done;await afterDelete;afterArchive.end();const afterResult=await afterArchive.done;
 check('archive parent fence permits cascading family deletion after publication',()=>{assert.equal(afterResult.code,0);assert.equal(sql('select count(*) from calendar_feed_source_revisions;'),'0');assert.equal(sql('select count(*) from calendar_feed_source_groups;'),'0');assert.equal(sql('select count(*) from calendar_feed_source_component_watermarks;'),'0');});
 seed();
 const writer=session();
 await writer.send('begin; '+auth(call([row('old'),row('new')],['history'])));
 check('concurrent reader sees complete old group before publication commit',()=>{
  assert.equal(sql(`select string_agg(external_uid||':'||title,',' order by external_uid) from calendar_events where feed_id=${q(feed)};`),'history:History,old:Old');
  assert.equal(sql(`select last_status from calendar_feeds where id=${q(feed)};`),'syncing');
 });
 await writer.send('commit;');writer.end();await writer.done;
 check('reader sees complete new group and settlement after commit',()=>{assert.equal(sql(`select string_agg(external_uid||':'||title,',' order by external_uid) from calendar_events where feed_id=${q(feed)};`),'new:New,old:New');assert.equal(sql(`select last_status from calendar_feeds where id=${q(feed)};`),'ok');});
 seed();
 sql("create function public.fixture_pause() returns trigger language plpgsql as $$begin if new.external_uid='pause' then perform pg_sleep(20); end if; return new; end$$;create trigger fixture_pause before insert on calendar_events for each row execute function public.fixture_pause();");
 const cancelled=session(),beforeCancel=state();
 const waiting=cancelled.send(auth(call([row('first'),row('pause')],['history']))).then(()=>{throw new Error('Expected cancellation');},()=>{});
 await waitFor(cancelled.app,"wait_event='PgSleep'");
 assert.equal(sql(`select pg_cancel_backend(pid) from pg_stat_activity where application_name=${q(cancelled.app)};`),'t');
 await waiting;cancelled.end();const cancelledResult=await cancelled.done;
 assert.match(cancelledResult.err,/57014/);check('cancellation after first mutation rolls back rows removals and settlement',()=>assert.equal(state(),beforeCancel));
 seed();
 const parent=session();await parent.send(`begin; select id from families where id=${q(family)} for update;`);
 const blocked=session(),blockedWork=blocked.send(auth(call([row('first')])));
 await waitFor(blocked.app,"wait_event_type='Lock'");
 await parent.send(`delete from families where id=${q(family)};commit;`);parent.end();await parent.done;
 await blockedWork;blocked.end();const blockedResult=await blocked.done;
 check('family deletion admits no stale publication after parent lock wait',()=>{assert.equal(blockedResult.code,0);assert.match(blockedResult.out,/lost/);assert.equal(sql(`select count(*) from calendar_events where family_id=${q(family)};`),'0');});
 seed();
 const publishing=session();await publishing.send('begin; '+auth(call([row('new')])));
 const deleting=session(),deletion=deleting.send(`delete from families where id=${q(family)};`);
 await waitFor(deleting.app,"wait_event_type='Lock'");
 await publishing.send('commit;');publishing.end();await publishing.done;
 await deletion;deleting.end();const deleteResult=await deleting.done;
 check('publication parent fence serializes a later family deletion without deadlock',()=>{assert.equal(deleteResult.code,0);assert.equal(sql(`select count(*) from calendar_events where family_id=${q(family)};`),'0');assert.equal(sql(`select count(*) from calendar_feeds where family_id=${q(family)};`),'0');});
 seed();
 // Privileged synthetic adversary bypasses FK triggers to reach the unique-index
 // conflict after the RPC's precheck, rather than serializing at the feed FK.
 const inserting=session();await inserting.send(`begin; set local session_replication_role=replica; insert into calendar_events(family_id,feed_id,external_uid,title,starts_at,source_recurrence) values(${q(family)},${q(feed)},'raced','Source','2026-10-08T09:00Z',${rows(document('raced'))});`);
 const legacy=session(),legacyWork=legacy.send(call([row('first'),row('raced')],['history'])).then(()=>{throw new Error('Expected erasure refusal');},()=>{});
 await waitFor(legacy.app,"wait_event_type='Lock'");
 await inserting.send('commit;');inserting.end();await inserting.done;
 await legacyWork;legacy.end();const legacyResult=await legacy.done;
 check('conflict-time source guard rolls back prior writes and removals',()=>{assert.match(legacyResult.err,/22023:.*Source metadata write refused at conflict/);assert.equal(sql(`select count(*) from calendar_events where feed_id=${q(feed)} and external_uid='first';`),'0');assert.equal(sql(`select source_recurrence->>'uid' from calendar_events where feed_id=${q(feed)} and external_uid='raced';`),'raced');assert.equal(sql(`select title from calendar_events where feed_id=${q(feed)} and external_uid='history';`),'History');assert.equal(sql(`select last_status from calendar_feeds where id=${q(feed)};`),'syncing');});
 const receipt={migration,migrationHash,checks,checkLabels,postgres:identity.split(/\r?\n/)[2],port,work,synthetic:true,applicationCallsNewEndpoint:false,qualifiedSourceEngine:false,directTableWritesGuarded:false,sourceArchive:{readOnlyTables:true,currentMembershipReads:true,immutableFamily:true,maxComponentWatermarksPerUID:20000,rawTypedAgreementQualified:false,unversionedChronologyQualified:false}};
 writeFileSync(join(work,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{
 for(const child of children)child.kill();
 if(created)run('psql',[...admin,'-c',`drop database "${database}" with (force);`]);
 if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
 console.log('Disposable cluster stopped: '+work);
}
