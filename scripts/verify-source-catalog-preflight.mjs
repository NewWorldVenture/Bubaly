// Synthetic catalog fixture only. Creates and stops its OWN local cluster;
// accepts no external connection, production credentials or apply options.
// node scripts/verify-source-catalog-preflight.mjs --bin /absolute/postgresql/bin
import assert from 'node:assert/strict';
import{execFileSync}from'node:child_process';import{mkdtempSync,readFileSync,writeFileSync}from'node:fs';import{join,dirname,resolve,isAbsolute}from'node:path';import{fileURLToPath}from'node:url';import{tmpdir}from'node:os';import{createServer}from'node:net';import{createHash}from'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert(process.argv.length===4 && process.argv[2]==='--bin' && isAbsolute(process.argv[3]),'Only explicit --bin /absolute/postgresql/bin is accepted; no connection arguments.');
const bin=process.argv[3],suffix=process.platform==='win32'?'.exe':'',work=mkdtempSync(join(tmpdir(),'bubaly-source-catalog-')),data=join(work,'data');
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PG')));Object.assign(env,{PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'5'});
const run=(name,args,input)=>execFileSync(join(bin,name+suffix),args,{env,input,encoding:'utf8',timeout:60000,stdio:name==='pg_ctl'?'ignore':['pipe','pipe','pipe']});
const base=['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'];
const sql=s=>run('psql',base,s).trim();let started=false;const checks=[];const check=(name,f)=>{f();checks.push(name);};
const query=readFileSync(join(root,'docs/final-audit/messaging-bill-readonly-preflight.sql'),'utf8');
const messagingIdentities=[
 'public.can_access_family_conversation(uuid)',
 'public.create_family_conversation(uuid,uuid[],text,text,text)',
 'public.toggle_family_message_reaction(uuid,text)',
 'public.mark_conversation_read_through(uuid,uuid)',
 'public.family_conversation_overview(uuid)',
];
function catalogOnly(text){
 const executable=text.replace(/'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\//g,' ').replace(/"((?:[^"]|"")*)"/g,(_,name)=>name.replaceAll('""','"'));
 assert(!/\b(?:public|storage|realtime|auth|supabase_migrations)\s*\./i.test(executable),'No executable application relation or routine references');
 for(const match of executable.matchAll(/\b(?:from|join)\s+(?:lateral\s+)?([a-z_][a-z0-9_.]*)/gi)){
  assert(/^(?:pg_catalog\.)?pg_[a-z_]+$/i.test(match[1])||['expected','callers','unnest','aclexplode'].includes(match[1].toLowerCase()),'Only catalog relations and explicit catalog CTEs/functions');
 }
 assert(!/\b(?:insert|update|delete|create|alter|drop|truncate|copy|call|do)\b/i.test(executable),'No executable mutation or procedural statements');
}
let receipt;
check('schema-only query contains no executable application-row reads or RPC calls',()=>catalogOnly(query));
check('catalog-only guard refuses restored aggregates and direct application RPC calls',()=>{
 for(const statement of ['select count(*) from public.family_messages;','select count(*) from "public"."family_conversations";','select count(*) from notifications;','select public.can_access_family_conversation(null);'])assert.throws(()=>catalogOnly(query.replace(/rollback;\s*$/i,statement+'\nrollback;')));
});
try{
 run('initdb',['-D',data,'-U','postgres','--auth=trust','--encoding=UTF8','--no-locale']);run('pg_ctl',['-D',data,'-l',join(work,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
 const identity=sql("select current_setting('data_directory'),inet_server_port(),current_setting('server_version');");assert(identity.startsWith(data.replaceAll('\\','/')+'|'+port+'|'));
 sql(`create role anon;create role authenticated;create role service_role;create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text,name text);
 create table public.family_conversations(id uuid,family_id uuid,participant_ids uuid[],member_ids uuid[],is_archived boolean,created_by uuid);
 create table public.family_messages(conversation_id uuid,family_id uuid);`);
 const absent=run('psql',[...base,'-f',join(root,'docs/final-audit/messaging-bill-readonly-preflight.sql')]);writeFileSync(join(work,'absent.txt'),absent);
 check('all five expected source/native tables produce explicit missing rows',()=>{for(const n of['calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks'])assert(absent.includes(n+'|f|'));});
 check('all eleven expected RPC/helper identities produce explicit missing rows',()=>{const rows=absent.split(/\r?\n/).filter(l=>/^(public\.calendar_|calendar_feed_private\.)/.test(l));assert.equal(rows.length,11);assert(rows.every(l=>l.endsWith('|f')));});
 check('missing private schema retains all three caller rows',()=>{for(const role of['anon','authenticated','service_role'])assert(absent.includes('calendar_feed_private|'+role+'|f|t|'));});
 check('preflight proves read-only transaction',()=>assert.match(absent,/^\d+\|on\|t\|/m));
 check('both missing preferences and notification tables have explicit rows',()=>{for(const name of['family_conversation_preferences','notifications'])assert.match(absent,new RegExp('^'+name+'\\|f\\|','m'));});
 check('all five missing messaging RPC identities have explicit rows',()=>{for(const name of messagingIdentities)assert(absent.split(/\r?\n/).includes(name+'|f'));});
 check('missing Storage and Realtime schemas still produce explicit table absence',()=>{for(const name of['storage|objects|f|','realtime|messages|f|'])assert(absent.split(/\r?\n/).some(line=>line.startsWith(name)));});
 sql(`create schema calendar_feed_private;revoke all on schema calendar_feed_private from public;grant usage on schema calendar_feed_private to service_role;
 create table public.calendar_feeds(id uuid primary key,family_id uuid not null);create table public.calendar_events(id uuid primary key,family_id uuid not null,feed_id uuid references public.calendar_feeds(id));
 create table public.calendar_feed_source_revisions(id uuid primary key,feed_id uuid not null references public.calendar_feeds(id),family_id uuid not null,document jsonb not null);
 alter table public.calendar_feed_source_revisions enable row level security;
 create policy source_fixture_read on public.calendar_feed_source_revisions for select to authenticated using(false);
 grant select on public.calendar_feed_source_revisions to authenticated;grant update(document) on public.calendar_feed_source_revisions to authenticated;
 create function public.calendar_read_occurrence_inputs(uuid) returns jsonb language sql stable as 'select null::jsonb';
 revoke all on function public.calendar_read_occurrence_inputs(uuid) from public;grant execute on function public.calendar_read_occurrence_inputs(uuid) to authenticated;
 create function public.calendar_feed_archive_sources(uuid,timestamptz,jsonb) returns jsonb language sql as 'select null::jsonb';
 create function calendar_feed_private.raw_identity(text,text,text) returns text language sql security definer set search_path=pg_catalog as 'select $1';
 create function calendar_feed_private.immutable_archive() returns trigger language plpgsql as 'begin return new; end;';
 create trigger source_fixture_immutable before update on public.calendar_feed_source_revisions for each row execute function calendar_feed_private.immutable_archive();
 alter default privileges in schema calendar_feed_private grant execute on functions to authenticated;`);
 sql(`alter table public.family_conversations add primary key(id);
 insert into public.family_conversations(id,family_id) values('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
 create table public.family_conversation_preferences(id uuid primary key,conversation_id uuid references public.family_conversations(id),muted boolean not null default false,payload text not null, constraint fixture_preference_payload check(length(payload)>0));
 create table public.notifications(id uuid primary key,read boolean not null default false,related_id text not null,payload text not null,constraint fixture_notification_related check(length(related_id)>0));
 insert into public.family_conversation_preferences values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',false,'OWNED-APPLICATION-ROW-SENTINEL');
 insert into public.notifications values('20000000-0000-4000-8000-000000000002',false,'synthetic','OWNED-APPLICATION-ROW-SENTINEL');
 alter table public.family_conversation_preferences enable row level security;
 alter table public.notifications enable row level security;alter table public.notifications force row level security;
 create policy fixture_preferences_read on public.family_conversation_preferences for select to authenticated using(false);
 create policy fixture_notifications_insert on public.notifications for insert to authenticated with check(false);
 grant select on public.family_conversation_preferences to authenticated;
 grant update(muted) on public.family_conversation_preferences to authenticated;
 grant insert on public.notifications to authenticated;
 create trigger fixture_preferences_trigger before update on public.family_conversation_preferences for each row execute function calendar_feed_private.immutable_archive();
 create trigger fixture_notifications_trigger before update on public.notifications for each row execute function calendar_feed_private.immutable_archive();
 create index fixture_family_messages_index on public.family_messages(family_id);
 create index fixture_preferences_index on public.family_conversation_preferences(conversation_id);
 create index fixture_notifications_index on public.notifications(related_id);
 create function public.can_access_family_conversation(uuid) returns boolean language plpgsql security invoker set search_path='' as $$begin raise exception 'Synthetic catalog RPC must not run';end;$$;
 create function public.create_family_conversation(uuid,uuid[],text,text,text) returns uuid language plpgsql security invoker set search_path='' as $$begin raise exception 'Synthetic catalog RPC must not run';end;$$;
 create function public.toggle_family_message_reaction(uuid,text) returns jsonb language plpgsql security invoker set search_path='' as $$begin raise exception 'Synthetic catalog RPC must not run';end;$$;
 create function public.mark_conversation_read_through(uuid,uuid) returns integer language plpgsql security invoker set search_path='' as $$begin raise exception 'Synthetic catalog RPC must not run';end;$$;
 create function public.family_conversation_overview(uuid) returns jsonb language plpgsql security invoker set search_path='' as $$begin raise exception 'Synthetic catalog RPC must not run';end;$$;
 revoke all on function public.can_access_family_conversation(uuid),public.create_family_conversation(uuid,uuid[],text,text,text),public.toggle_family_message_reaction(uuid,text),public.mark_conversation_read_through(uuid,uuid),public.family_conversation_overview(uuid) from public;
 grant execute on function public.can_access_family_conversation(uuid),public.create_family_conversation(uuid,uuid[],text,text,text),public.toggle_family_message_reaction(uuid,text),public.mark_conversation_read_through(uuid,uuid),public.family_conversation_overview(uuid) to authenticated;
 create schema storage;create schema realtime;
 create table storage.objects(id uuid primary key,payload text);create table realtime.messages(id uuid primary key,payload text);
 alter table storage.objects enable row level security;alter table realtime.messages enable row level security;alter table realtime.messages force row level security;
 create policy fixture_storage_read on storage.objects for select to authenticated using(false);
 create policy fixture_realtime_write on realtime.messages for insert to authenticated with check(false);
 create role catalog_only_reader;
 grant usage on schema public,storage,realtime,calendar_feed_private,supabase_migrations to catalog_only_reader;`);
 const present=run('psql',[...base,'-f',join(root,'docs/final-audit/messaging-bill-readonly-preflight.sql')]);writeFileSync(join(work,'present.txt'),present);
 check('present and still-missing source tables remain separately explicit',()=>{assert.match(present,/^calendar_feed_source_revisions\|t\|r\|t\|f\|postgres$/m);assert(present.includes('calendar_feed_source_groups|f|'));assert(present.includes('calendar_feed_source_component_watermarks|f|'));});
 check('exact expected RPC/helper identities distinguish present from absent',()=>{assert(present.includes('public.calendar_read_occurrence_inputs(uuid)|t'));assert(present.includes('public.calendar_feed_archive_sources(uuid,timestamp with time zone,jsonb)|t'));assert(present.includes('calendar_feed_private.raw_identity(text,text,text)|t'));assert(present.includes('calendar_feed_private.validate_value(jsonb,text,text)|f'));});
 check('private schema effective caller privileges are visible',()=>{assert(present.includes('calendar_feed_private|anon|t|t|postgres|f|f'));assert(present.includes('calendar_feed_private|service_role|t|t|postgres|t|f'));});
 check('source constraints/indexes/policies/triggers/columns are all inventoried',()=>{for(const n of['calendar_feed_source_revisions_pkey','calendar_feed_source_revisions_feed_id_fkey','source_fixture_read','source_fixture_immutable','document'])assert(present.includes(n));});
 check('column-only update and table grants are not conflated',()=>{assert(present.includes('calendar_feed_source_revisions|authenticated|t|f|f|f|document|t'));assert(present.includes('calendar_feed_source_revisions|authenticated|t|f|f|f|id|f'));});
 check('unsafe PUBLIC function grant remains observable, not auto-accepted',()=>assert.match(present,/^public\|calendar_feed_archive_sources\|.*\|anon\|t\|t$/m));
 check('restricted invoker RPC shows anonymous execute denial',()=>assert.match(present,/^public\|calendar_read_occurrence_inputs\|.*\|anon\|t\|f$/m));
 check('private helpers and private default execute ACLs are included',()=>{assert.match(present,/^calendar_feed_private\|raw_identity\|.*\|anon\|f\|t$/m);assert(present.includes('calendar_feed_private|postgres|f|authenticated|EXECUTE|f'));});
 check('preflight neither writes fixture rows nor invokes catalogued RPCs',()=>{assert.equal(sql('select count(*) from public.calendar_feed_source_revisions;'),'0');assert.match(present,/^\d+\|on\|t\|/m);});
 check('present messaging tables expose distinct RLS and forced-RLS metadata',()=>{assert.match(present,/^family_conversation_preferences\|t\|r\|t\|f\|postgres$/m);assert.match(present,/^notifications\|t\|r\|t\|t\|postgres$/m);});
 check('both messaging tables expose columns/defaults/constraints/indexes/policies/triggers',()=>{for(const name of['fixture_preference_payload','fixture_notification_related','family_conversation_preferences_conversation_id_fkey','family_conversation_preferences_pkey','notifications_pkey','fixture_preferences_read','fixture_notifications_insert','fixture_preferences_trigger','fixture_notifications_trigger'])assert(present.includes(name));assert.match(present,/^public\|family_conversation_preferences\|.*\|muted\|boolean\|t\|false$/m);assert.match(present,/^public\|notifications\|.*\|read\|boolean\|t\|false$/m);assert.match(present,/^family_conversation_preferences\|fixture_preferences_index\|/m);assert.match(present,/^notifications\|fixture_notifications_index\|/m);});
 check('preferences column-only and notification table grants remain distinct',()=>{assert(present.includes('family_conversation_preferences|authenticated|t|f|f|f|muted|t'));assert(present.includes('family_conversation_preferences|authenticated|t|f|f|f|payload|f'));assert(present.includes('notifications|authenticated|f|t|f|f|payload|f'));});
 check('all five present messaging RPC identities and effective grants are inventoried without invocation',()=>{for(const name of messagingIdentities){assert(present.split(/\r?\n/).includes(name+'|t'));const routine=name.slice(7,name.indexOf('('));assert.match(present,new RegExp('^public\\|'+routine+'\\|.*\\|anon\\|t\\|f$','m'));assert.match(present,new RegExp('^public\\|'+routine+'\\|.*\\|authenticated\\|t\\|t$','m'));}});
 check('Storage and Realtime presence/RLS metadata is schema-qualified',()=>{assert.match(present,/^storage\|objects\|t\|r\|t\|f\|postgres$/m);assert.match(present,/^realtime\|messages\|t\|r\|t\|t\|postgres$/m);});
 check('Storage and Realtime policy metadata retains schema/roles/command/predicates',()=>{assert.match(present,/^storage\|objects\|fixture_storage_read\|PERMISSIVE\|\{authenticated\}\|SELECT\|false\|$/m);assert.match(present,/^realtime\|messages\|fixture_realtime_write\|PERMISSIVE\|\{authenticated\}\|INSERT\|\|false$/m);});
 check('message index catalog scope includes family_messages',()=>assert.match(present,/^family_messages\|fixture_family_messages_index\|/m));
 const catalogReader=run('psql',[...base,'-c','set role catalog_only_reader;','-f',join(root,'docs/final-audit/messaging-bill-readonly-preflight.sql')]);writeFileSync(join(work,'catalog-reader.txt'),catalogReader);
 check('schema-only preflight succeeds with no application-table SELECT privileges',()=>{assert.equal(sql("select has_table_privilege('catalog_only_reader','public.family_messages','SELECT'),has_table_privilege('catalog_only_reader','public.family_conversation_preferences','SELECT'),has_table_privilege('catalog_only_reader','public.notifications','SELECT');"),'f|f|f');assert(catalogReader.includes('public.can_access_family_conversation(uuid)|t'));assert(!catalogReader.includes('OWNED-APPLICATION-ROW-SENTINEL'));});
 check('read-only catalog capture leaves nonempty application fixture rows untouched and private',()=>{assert.equal(sql('select count(*) from public.family_conversation_preferences;'),'1');assert.equal(sql('select count(*) from public.notifications;'),'1');assert(!present.includes('OWNED-APPLICATION-ROW-SENTINEL'));});
 receipt={synthetic:true,productionExecuted:false,verifierSha256Lf:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url),'utf8').replaceAll('\r\n','\n')).digest('hex'),postgres:identity,port,work,querySha256Lf:createHash('sha256').update(query.replaceAll('\r\n','\n')).digest('hex'),checks:checks.length,labels:checks};
}finally{if(started){run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);assert.throws(()=>run('pg_ctl',['-D',data,'status']),error=>error.status===3);if(receipt){receipt.ownedClusterStopped=true;writeFileSync(join(work,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}console.log('Owned disposable cluster stopped: '+work);}else{console.log('Cluster startup not confirmed; no successful receipt: '+work);}}
