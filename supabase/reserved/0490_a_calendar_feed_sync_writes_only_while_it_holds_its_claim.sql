-- RESERVED, UNAPPLIED, HELD 0490. 0475-0489 must land before promotion.
-- Neither this source document nor the new publication endpoint enables an
-- occurrence engine. The app does not call publish_snapshot yet.
-- Current app imports/readers still use the family clock for legacy series.
-- source_recurrence is a preservation foundation, not an enabled source-clock engine.
-- Legacy apply_sync remains a chunk operation and NEVER settles the feed.
-- Only exact supplied cancellation/retired-exception keys are deleted; absence
-- from a snapshot retains history. Both functions are invokers under caller RLS.
-- Erasure guards cover these RPCs only. Existing direct calendar_events UPDATE
-- permissions remain: future imported actions must preserve source or be read-only.
-- Structural checks do not certify all RFC rule or raw-vs-typed semantics.
alter table public.calendar_events add column if not exists source_recurrence jsonb;
do $$ begin
 if not exists(select 1 from pg_attribute where attrelid='public.calendar_events'::regclass and attname='source_recurrence'
   and atttypid='jsonb'::regtype and not attnotnull and not atthasdef and not attisdropped)
 then raise exception '0490 incompatible source_recurrence column: nullable JSONB without default required'; end if;
end $$;
comment on column public.calendar_events.source_recurrence is
 'ImportedSourceDocument v1: bare UID, master, overrides, publisher clocks and revisions. SQL NULL is native/legacy. Held candidate; not occurrence expansion.';

create schema if not exists calendar_feed_private;
revoke all on schema calendar_feed_private from public,anon;
grant usage on schema calendar_feed_private to authenticated,service_role;

-- Framing/identity only. Raw-vs-typed rule semantics remain unverified until
-- the future occurrence engine reparses them. Preserve exact raw spelling.
create or replace function calendar_feed_private.raw_identity(raw text, frame text, identity text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare line text; pair text[]; stack text[]:='{}'; ids integer:=0; decoded text; key text;
begin
 if raw ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' or replace(raw,E'\r\n','') like '%'||E'\r'||'%'
 then raise exception 'Invalid raw source controls' using errcode='22023'; end if;
 for line in select unnest(string_to_array(regexp_replace(replace(raw,E'\r\n',E'\n'),E'\n[ \t]','','g'),E'\n')) loop
   if line='' then continue; end if;
   pair:=regexp_match(line,'^((?:[^:"]|"[^"]*")*):(.*)$');
   if pair is null then raise exception 'Invalid raw property frame' using errcode='22023'; end if;
   key:=upper(split_part(pair[1],';',1));
   if key='BEGIN' then
     if cardinality(stack)=0 and upper(pair[2])<>frame then raise exception 'Invalid raw component frame' using errcode='22023'; end if;
     stack:=array_append(stack,upper(pair[2]));
   elsif key='END' then
     if cardinality(stack)=0 or stack[cardinality(stack)]<>upper(pair[2]) then raise exception 'Unbalanced raw component' using errcode='22023'; end if;
     stack:=stack[1:cardinality(stack)-1];
   elsif cardinality(stack)=0 then raise exception 'Property outside raw component' using errcode='22023';
   elsif cardinality(stack)=1 and key=(case when frame='VEVENT' then 'UID' else 'TZID' end) then
     decoded:=regexp_replace(pair[2],E'\\\\([,;\\\\])',E'\\1','g');
     decoded:=regexp_replace(decoded,E'\\\\[nN]',E'\n','g');
     if decoded<>identity then raise exception 'Raw source identity crossover' using errcode='22023'; end if;
     ids:=ids+1;
   end if;
 end loop;
 if cardinality(stack)<>0 or ids<>1 then raise exception 'Raw component identity/frame missing' using errcode='22023'; end if;
end $$;
revoke all on function calendar_feed_private.raw_identity(text,text,text) from public,anon;
grant execute on function calendar_feed_private.raw_identity(text,text,text) to authenticated,service_role;

-- A pure recursive structural validator. No tenant reads, writes or privileges.
-- All object keys are required and unknown keys are refused at each level.
create or replace function calendar_feed_private.validate_value(v jsonb, kind text, uid text)
returns void language plpgsql immutable security invoker set search_path='' as $$
declare keys text[]; x jsonb; field text; actual text; n numeric;
begin
 if jsonb_typeof(v) is distinct from 'object' then raise exception 'Invalid source % object',kind using errcode='22023'; end if;
 keys:=case kind
 when 'document' then array['version','uid','master','overrides','timezones','revision','rawProperties']
 when 'component' then array['uid','title','description','location','status','dtstart','end','rrule','rdates','exdates','revision','raw']
 when 'override' then array['uid','title','description','location','status','dtstart','end','rrule','rdates','exdates','revision','raw','recurrenceId','range']
 when 'revision' then array['sequence','dtstamp','lastModified','etag']
 when 'timezone' then array['tzid','raw']
 when 'time' then case when v->>'kind'='zoned' then array['kind','value','tzid'] else array['kind','value'] end
 when 'end' then case when v->>'kind'='default' then array['kind'] else array['kind','value'] end
 when 'rdate' then case when v->>'kind'='period' then array['kind','start','end'] else array['kind','value'] end
 else null end;
 if keys is null or not(v ?& keys) or (v-keys)<>'{}'::jsonb then raise exception 'Invalid source % fields',kind using errcode='22023'; end if;
 if kind in ('document','component','override') and
   (jsonb_typeof(v->'uid') is distinct from 'string' or v->>'uid' is distinct from uid)
 then raise exception 'Source UID crossover' using errcode='22023'; end if;
 if kind='document' then
   if v->'version' is distinct from '1'::jsonb or jsonb_typeof(v->'overrides') is distinct from 'array'
     or jsonb_typeof(v->'timezones') is distinct from 'array' or jsonb_typeof(v->'rawProperties') is distinct from 'array' then raise exception 'Invalid source version/collections' using errcode='22023'; end if;
   if v->'master'='null'::jsonb and jsonb_array_length(v->'overrides')=0 then raise exception 'Empty source group' using errcode='22023'; end if;
   if jsonb_array_length(v->'rawProperties')>1000 then raise exception 'Raw property count limit' using errcode='22023'; end if;
   for x in select value from jsonb_array_elements(v->'rawProperties') loop
     if jsonb_typeof(x) is distinct from 'string' or length(x#>>'{}')>262144
       or x#>>'{}' ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
       or replace(x#>>'{}',E'\r\n','') like '%'||E'\r'||'%'
     then raise exception 'Invalid raw source property' using errcode='22023'; end if;
   end loop;
   if exists(select 1 from jsonb_array_elements(v->'timezones') z group by z->>'tzid' having count(*)>1)
     or exists(select 1 from jsonb_array_elements(v->'overrides') o group by o->'recurrenceId' having count(*)>1)
   then raise exception 'Duplicate source identity' using errcode='22023'; end if;
   if jsonb_array_length(v->'overrides')>2000 or jsonb_array_length(v->'timezones')>32 then raise exception 'Source collection limit' using errcode='22023'; end if;
   if v->'master'<>'null'::jsonb then perform calendar_feed_private.validate_value(v->'master','component',uid); end if;
   for x in select value from jsonb_array_elements(v->'overrides') loop perform calendar_feed_private.validate_value(x,'override',uid); end loop;
   for x in select value from jsonb_array_elements(v->'overrides') loop
     if (v->'master'->'dtstart'<>'null'::jsonb and v->'master'<>'null'::jsonb
       and (x->'recurrenceId'->>'kind' is distinct from v->'master'->'dtstart'->>'kind'
         or x->'recurrenceId'->>'tzid' is distinct from v->'master'->'dtstart'->>'tzid'))
       or (x->'dtstart'<>'null'::jsonb and (x->'recurrenceId'->>'kind'='date') is distinct from (x->'dtstart'->>'kind'='date'))
     then raise exception 'Override original clock/type mismatch' using errcode='22023'; end if;
   end loop;
   for x in select value from jsonb_array_elements(v->'timezones') loop perform calendar_feed_private.validate_value(x,'timezone',uid); end loop;
   perform calendar_feed_private.validate_value(v->'revision','revision',uid);
 elsif kind in ('component','override') then
   if jsonb_typeof(v->'status') is distinct from 'string' or v->>'status' not in ('confirmed','tentative','cancelled')
     or jsonb_typeof(v->'rdates') is distinct from 'array' or jsonb_typeof(v->'exdates') is distinct from 'array'
   then raise exception 'Invalid source component' using errcode='22023'; end if;
   if jsonb_array_length(v->'rdates')>5000 or jsonb_array_length(v->'exdates')>5000 then raise exception 'Source date limit' using errcode='22023'; end if;
   foreach field in array array['title','description','location','rrule'] loop
     if jsonb_typeof(v->field) not in ('string','null') or length(v->>field)>65536 then raise exception 'Invalid source text' using errcode='22023'; end if;
   end loop;
   if jsonb_typeof(v->'raw') not in ('string','null') or length(v->>'raw')>262144 then raise exception 'Invalid raw component' using errcode='22023'; end if;
   if v->'raw'<>'null'::jsonb and (v->>'raw' !~* '^BEGIN:VEVENT\r?\n' or v->>'raw' !~* '\r?\nEND:VEVENT\r?\n?$')
   then raise exception 'Invalid raw VEVENT frame' using errcode='22023'; end if;
   if v->'raw'<>'null'::jsonb then perform calendar_feed_private.raw_identity(v->>'raw','VEVENT',uid); end if;
   if (v->'dtstart'='null'::jsonb and (v->>'status'<>'cancelled' or v->'end'<>'null'::jsonb or v->'rrule'<>'null'::jsonb or jsonb_array_length(v->'rdates')>0 or jsonb_array_length(v->'exdates')>0))
     or (v->'dtstart'<>'null'::jsonb and v->'end'='null'::jsonb) then raise exception 'Invalid live/cancelled source semantics' using errcode='22023'; end if;
   if v->'dtstart'<>'null'::jsonb then perform calendar_feed_private.validate_value(v->'dtstart','time',uid); end if;
   if v->'end'<>'null'::jsonb then perform calendar_feed_private.validate_value(v->'end','end',uid); end if;
   for x in select value from jsonb_array_elements(v->'rdates') loop
     perform calendar_feed_private.validate_value(x,'rdate',uid);
     if (x->>'kind'='time' and (x->'value'->>'kind'='date') is distinct from (v->'dtstart'->>'kind'='date'))
       or (x->>'kind'='period' and (v->'dtstart'->>'kind'='date' or x->'start'->>'kind'='date'))
     then raise exception 'RDATE source type mismatch' using errcode='22023'; end if;
   end loop;
   for x in select value from jsonb_array_elements(v->'exdates') loop
     perform calendar_feed_private.validate_value(x,'time',uid);
     if (x->>'kind'='date') is distinct from (v->'dtstart'->>'kind'='date') then raise exception 'EXDATE type mismatch' using errcode='22023'; end if;
   end loop;
   if v->'end'->>'kind'='dtend' and ((v->'end'->'value'->>'kind'='date') is distinct from (v->'dtstart'->>'kind'='date'))
   then raise exception 'DTEND type mismatch' using errcode='22023'; end if;
   if v->'end'->>'kind'='dtend' and v->'dtstart'->>'kind'=v->'end'->'value'->>'kind'
     and (v->'dtstart'->>'kind'<>'zoned' or v->'dtstart'->>'tzid'=v->'end'->'value'->>'tzid')
     and v->'end'->'value'->>'value'<=v->'dtstart'->>'value'
   then raise exception 'DTEND must follow DTSTART' using errcode='22023'; end if;
   if v->'end'->>'kind'='duration' and v->'dtstart'->>'kind'='date' and v->'end'->>'value' ~* 'T'
   then raise exception 'DATE duration cannot contain time' using errcode='22023'; end if;
   perform calendar_feed_private.validate_value(v->'revision','revision',uid);
   if kind='override' then
     if jsonb_typeof(v->'range') is distinct from 'string' or v->>'range' not in ('none','THISANDFUTURE') then raise exception 'Invalid override range' using errcode='22023'; end if;
     perform calendar_feed_private.validate_value(v->'recurrenceId','time',uid);
   end if;
 elsif kind='revision' then
   if v->'sequence'<>'null'::jsonb then
     if jsonb_typeof(v->'sequence')<>'number' or v->>'sequence' !~ '^[0-9]+$' then raise exception 'Invalid sequence' using errcode='22023'; end if;
     n:=(v->>'sequence')::numeric;
     if n>2147483647 then raise exception 'Invalid sequence' using errcode='22023'; end if;
   end if;
   foreach field in array array['dtstamp','lastModified','etag'] loop
     if jsonb_typeof(v->field) not in ('string','null') or length(v->>field)>4096 then raise exception 'Invalid revision text' using errcode='22023'; end if;
     if field<>'etag' and v->field<>'null'::jsonb then perform calendar_feed_private.validate_value(jsonb_build_object('kind','utc','value',v->field),'time',uid); end if;
   end loop;
 elsif kind='timezone' then
   if jsonb_typeof(v->'tzid') is distinct from 'string' or length(v->>'tzid') not between 1 and 4096
     or v->>'tzid' ~ '[[:cntrl:]]' or jsonb_typeof(v->'raw') is distinct from 'string' or length(v->>'raw')>262144
   then raise exception 'Invalid timezone definition' using errcode='22023'; end if;
   perform calendar_feed_private.raw_identity(v->>'raw','VTIMEZONE',v->>'tzid');
 elsif kind='time' then
   actual:=v->>'value';
   if jsonb_typeof(v->'value') is distinct from 'string' then raise exception 'Invalid source time' using errcode='22023'; end if;
   if v->>'kind'='zoned' and (jsonb_typeof(v->'tzid') is distinct from 'string' or length(v->>'tzid') not between 1 and 4096 or v->>'tzid' ~ '[[:cntrl:]]') then raise exception 'Invalid source timezone' using errcode='22023'; end if;
   if (v->>'kind'='date' and actual ~ '^[0-9]{8}$') or (v->>'kind'='utc' and actual ~ '^[0-9]{8}T[0-9]{6}Z$')
     or (v->>'kind' in ('zoned','floating') and actual ~ '^[0-9]{8}T[0-9]{6}$') then
     begin
       if to_char(to_date(left(actual,8),'YYYYMMDD'),'YYYYMMDD')<>left(actual,8)
         or (v->>'kind'<>'date' and (substring(actual,10,2)::int>23 or substring(actual,12,2)::int>59 or substring(actual,14,2)::int>60))
       then raise exception 'Invalid source date/time' using errcode='22023'; end if;
     exception when datetime_field_overflow or invalid_datetime_format then raise exception 'Invalid source date/time' using errcode='22023'; end;
   else raise exception 'Invalid source time kind/value' using errcode='22023'; end if;
 elsif kind='end' then
   if v->>'kind'='default' then null;
   elsif v->>'kind'='dtend' then perform calendar_feed_private.validate_value(v->'value','time',uid);
   elsif v->>'kind'='duration' and jsonb_typeof(v->'value')='string' and length(v->>'value')<=128
     and v->>'value' ~* '^\+?P([0-9]+W|([0-9]+D)?(T([0-9]+H)?([0-9]+M)?([0-9]+S)?)?)$' and v->>'value' !~* 'T$' and v->>'value' ~ '[1-9]' then null;
   else raise exception 'Invalid source end' using errcode='22023'; end if;
 elsif kind='rdate' then
   if v->>'kind'='time' then perform calendar_feed_private.validate_value(v->'value','time',uid);
   elsif v->>'kind'='period' and v->'end'->>'kind' in ('dtend','duration') then
     perform calendar_feed_private.validate_value(v->'start','time',uid);
     perform calendar_feed_private.validate_value(v->'end','end',uid);
     if v->'start'->>'kind'='date' or (v->'end'->>'kind'='dtend' and
       (v->'end'->'value'->>'kind'='date' or (v->'start'->>'kind'=v->'end'->'value'->>'kind'
         and (v->'start'->>'kind'<>'zoned' or v->'start'->>'tzid'=v->'end'->'value'->>'tzid')
         and v->'end'->'value'->>'value'<=v->'start'->>'value')))
     then raise exception 'Invalid RDATE PERIOD type/order' using errcode='22023'; end if;
   else raise exception 'Invalid RDATE' using errcode='22023'; end if;
 end if;
end $$;
revoke all on function calendar_feed_private.validate_value(jsonb,text,text) from public,anon;
grant execute on function calendar_feed_private.validate_value(jsonb,text,text) to authenticated,service_role;

create or replace function public.calendar_feed_apply_sync(p_feed_id uuid,p_fence timestamptz,p_upserts jsonb,p_removals text[])
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
#variable_conflict use_column
declare v_columns text; v_updates text; v_family uuid; v_locked_family uuid; e jsonb; k text; d jsonb; depth_max integer; node_count bigint; m jsonb; token text; expected timestamptz; affected integer;
begin
 -- Read only to discover the parent, lock parent first, then recheck feed identity.
 select family_id into v_family from public.calendar_feeds where id=p_feed_id;
 if not found then return 'lost'; end if;
 perform id from public.families where id=v_family for key share;
 if not found then return 'lost'; end if;
 select family_id into v_locked_family from public.calendar_feeds where id=p_feed_id and last_status='syncing' and updated_at=p_fence for update;
 if not found then return 'lost'; end if;
 if v_locked_family is distinct from v_family then raise exception 'Feed family changed' using errcode='42501'; end if;
 if p_upserts is not null and jsonb_typeof(p_upserts) is distinct from 'array' then raise exception 'Upserts must be an array' using errcode='22023'; end if;
 if octet_length(coalesce(p_upserts,'[]')::text)>8388608 or coalesce(jsonb_array_length(p_upserts),0)>2000
   or coalesce(cardinality(p_removals),0)>20000 or octet_length(coalesce(to_jsonb(p_removals),'[]')::text)>1048576
 then raise exception 'Publication payload limit' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_removals) r where r is null or length(r) not between 1 and 8192) then raise exception 'Invalid removal key' using errcode='22023'; end if;
 for e in select value from jsonb_array_elements(coalesce(p_upserts,'[]')) loop
   if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'external_uid') is distinct from 'string' or length(e->>'external_uid') not between 1 and 8192 then raise exception 'Invalid row identity' using errcode='22023'; end if;
   if (e ? 'family_id' and nullif(e->>'family_id','')::uuid is distinct from v_family)
     or (e ? 'feed_id' and nullif(e->>'feed_id','')::uuid is distinct from p_feed_id)
   then raise exception 'A row names a family/feed other than the locked feed' using errcode='42501'; end if;
   for k in select jsonb_object_keys(e) loop
     if k not in ('family_id','feed_id','external_uid','title','description','location','starts_at','ends_at','all_day','recurrence','category','source_recurrence')
     then raise exception 'Projection field is not writable: %',k using errcode='42703'; end if;
   end loop;
   if e ? 'source_recurrence' then
     if e->'recurrence' is distinct from '"none"'::jsonb then raise exception 'Source foundation requires recurrence none until qualified reader integration' using errcode='22023'; end if;
     if not(e ?& array['title','all_day','starts_at','ends_at']) then raise exception 'Source write requires complete verified projection' using errcode='22023'; end if;
     d:=e->'source_recurrence';
     if jsonb_typeof(d) is distinct from 'object' or octet_length(d::text)>1048576
       or length(e->>'external_uid')>4096 or e->>'external_uid' ~ '[\x01-\x08\x0A-\x1F\x7F]'
     then raise exception 'Invalid source document/UID/size' using errcode='22023'; end if;
     with recursive nodes(v,depth) as (
       select d,0 union all
       select child.v,n.depth+1 from nodes n cross join lateral (
         select value v from jsonb_each(case when jsonb_typeof(n.v)='object' then n.v else '{}'::jsonb end)
         union all select value from jsonb_array_elements(case when jsonb_typeof(n.v)='array' then n.v else '[]'::jsonb end)
       ) child where n.depth<=16
     ) select max(depth),count(*) into depth_max,node_count from nodes;
     if depth_max>16 or node_count>50000 then raise exception 'Source traversal limit' using errcode='22023'; end if;
     perform calendar_feed_private.validate_value(d,'document',e->>'external_uid');
     m:=d->'master';
     if m='null'::jsonb or m->>'status'='cancelled' or m->'dtstart'='null'::jsonb then raise exception 'Projection requires live source master' using errcode='22023'; end if;
     if (e ? 'title' and e->'title' is distinct from m->'title')
       or (e ? 'all_day' and e->'all_day' is distinct from to_jsonb(m->'dtstart'->>'kind'='date'))
     then raise exception 'Source projection title/all_day mismatch' using errcode='22023'; end if;
     if e ? 'starts_at' then
       token:=m->'dtstart'->>'value';
       if m->'dtstart'->>'kind' not in ('utc','date') or substring(token,14,2)='60' then raise exception 'Projection requires qualified source clock resolver' using errcode='22023'; end if;
       expected:=make_timestamptz(left(token,4)::int,substring(token,5,2)::int,substring(token,7,2)::int,
         case when length(token)=8 then 0 else substring(token,10,2)::int end,
         case when length(token)=8 then 0 else substring(token,12,2)::int end,
         case when length(token)=8 then 0 else substring(token,14,2)::int end,'UTC');
       if (e->>'starts_at')::timestamptz is distinct from expected then raise exception 'Source projection start mismatch' using errcode='22023'; end if;
     end if;
     if e ? 'ends_at' then
       if m->'end'->>'kind'='default' and m->'dtstart'->>'kind'<>'date' then
         if e->'ends_at'<>'null'::jsonb then raise exception 'Source default end mismatch' using errcode='22023'; end if;
       elsif m->'end'->>'kind'='default' and m->'dtstart'->>'kind'='date' then
         token:=m->'dtstart'->>'value';
         expected:=make_timestamptz(left(token,4)::int,substring(token,5,2)::int,substring(token,7,2)::int,0,0,0,'UTC')+interval '24 hours';
         if (e->>'ends_at')::timestamptz is distinct from expected then raise exception 'Source default DATE end mismatch' using errcode='22023'; end if;
       elsif m->'end'->>'kind'='dtend' and m->'end'->'value'->>'kind' in ('utc','date') then
         token:=m->'end'->'value'->>'value';
         if substring(token,14,2)='60' then raise exception 'Projection requires qualified source clock resolver' using errcode='22023'; end if;
         expected:=make_timestamptz(left(token,4)::int,substring(token,5,2)::int,substring(token,7,2)::int,
           case when length(token)=8 then 0 else substring(token,10,2)::int end,
           case when length(token)=8 then 0 else substring(token,12,2)::int end,
           case when length(token)=8 then 0 else substring(token,14,2)::int end,'UTC');
         if (e->>'ends_at')::timestamptz is distinct from expected then raise exception 'Source projection end mismatch' using errcode='22023'; end if;
       else raise exception 'End projection requires qualified source clock resolver' using errcode='22023'; end if;
     end if;
   end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(p_upserts,'[]')) e group by e->>'external_uid' having count(*)>1)
 then raise exception 'Duplicate upsert key' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_upserts,'[]')) e where e->>'external_uid'=any(p_removals))
 then raise exception 'Key both upserted and removed' using errcode='22023'; end if;
 -- Hold event locks across the metadata-erasure check, including direct writers.
 perform id from public.calendar_events where feed_id=p_feed_id and external_uid in
   (select value->>'external_uid' from jsonb_array_elements(coalesce(p_upserts,'[]'))) order by id for update;
 if exists(select 1 from jsonb_array_elements(coalesce(p_upserts,'[]')) e join public.calendar_events ce
   on ce.feed_id=p_feed_id and ce.external_uid=e->>'external_uid'
   where ce.source_recurrence is not null and not(e ? 'source_recurrence'))
 then raise exception 'Source metadata must not be erased by a legacy write' using errcode='22023'; end if;
 -- Per-row projection avoids a union of keys turning another row's omissions
 -- into NULLs. Conflict-time metadata guard also covers a concurrent new insert.
 for e in select value from jsonb_array_elements(coalesce(p_upserts,'[]')) loop
   select string_agg(format('%I',k),', ' order by k),string_agg(format('%I = excluded.%I',k,k),', ' order by k)
   into v_columns,v_updates from jsonb_object_keys(e) k where k not in ('feed_id','family_id','external_uid');
   if v_columns is null then raise exception 'Rows carry no projection fields' using errcode='22023'; end if;
   execute format('insert into public.calendar_events(feed_id,family_id,external_uid,%1$s)
     select %2$L::uuid,%3$L::uuid,r.external_uid,%4$s from jsonb_populate_record(null::public.calendar_events,$1) r
     on conflict (feed_id, external_uid) do update set %5$s
     where calendar_events.source_recurrence is null or excluded.source_recurrence is not null',v_columns,p_feed_id,v_family,
     (select string_agg(format('r.%I',k),', ' order by k) from jsonb_object_keys(e) k where k not in ('feed_id','family_id','external_uid')),v_updates) using e;
   get diagnostics affected=row_count;
   if affected<>1 then raise exception 'Source metadata write refused at conflict' using errcode='22023'; end if;
 end loop;
 delete from public.calendar_events where feed_id=p_feed_id and external_uid=any(p_removals);
 return 'applied';
end $$;
revoke all on function public.calendar_feed_apply_sync(uuid,timestamptz,jsonb,text[]) from public,anon;
grant execute on function public.calendar_feed_apply_sync(uuid,timestamptz,jsonb,text[]) to authenticated,service_role;

create or replace function public.calendar_feed_publish_snapshot(p_feed_id uuid,p_fence timestamptz,p_upserts jsonb,p_removals text[])
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare answer text;
begin
 answer:=public.calendar_feed_apply_sync(p_feed_id,p_fence,p_upserts,p_removals);
 if answer='lost' then return answer; end if;
 -- Same transaction/locks: a failed or cancelled statement rolls back ALL changes.
 update public.calendar_feeds set last_status='ok',last_error=null,last_synced_at=clock_timestamp(),
   event_count=(select count(*) from public.calendar_events where feed_id=p_feed_id)
   where id=p_feed_id and last_status='syncing' and updated_at=p_fence;
 if not found then raise exception 'Feed settlement refused' using errcode='42501'; end if;
 return 'applied';
end $$;
revoke all on function public.calendar_feed_publish_snapshot(uuid,timestamptz,jsonb,text[]) from public,anon;
grant execute on function public.calendar_feed_publish_snapshot(uuid,timestamptz,jsonb,text[]) to authenticated,service_role;
comment on function public.calendar_feed_apply_sync(uuid,timestamptz,jsonb,text[]) is
 'Held 0490 chunk: locks family then live feed claim; validated projection/source upserts and exact removals only, no settlement. Invoker RLS.';
comment on function public.calendar_feed_publish_snapshot(uuid,timestamptz,jsonb,text[]) is
 'Held 0490 candidate, not called by app: bounded whole-feed publication, explicit removals and success settlement atomically. Absent UID history retained. Invoker RLS.';
