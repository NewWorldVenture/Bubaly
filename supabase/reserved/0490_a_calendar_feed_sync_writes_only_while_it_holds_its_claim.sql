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

-- HELD source archive path. No application caller or occurrence reader is enabled.
-- Exact JSON/raw spelling is retained; structural validation is NOT a proof of
-- raw/typed agreement, RFC materialization, or chronological ETag ordering.
create or replace function calendar_feed_private.archive_document(d jsonb, uid text)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare depth_max integer; nodes bigint;
begin
 if uid is null or length(uid) not between 1 and 4096 or uid ~ '[[:cntrl:]]'
   or d is null or octet_length(d::text)>1048576 then raise exception 'Archive document limit/identity' using errcode='22023'; end if;
 with recursive tree(v,depth) as (
   select d,0 union all select x.v,t.depth+1 from tree t cross join lateral (
     select value v from jsonb_each(case when jsonb_typeof(t.v)='object' then t.v else '{}'::jsonb end)
     union all select value from jsonb_array_elements(case when jsonb_typeof(t.v)='array' then t.v else '[]'::jsonb end)
   ) x where t.depth<17
 ) select max(depth),count(*) into depth_max,nodes from tree;
 if depth_max>16 or nodes>50000 then raise exception 'Archive document complexity limit' using errcode='22023'; end if;
 perform calendar_feed_private.validate_value(d,'document',uid);
 return true;
end $$;

-- Compare only revisions of the SAME original component. NULL is unknown,
-- not equality; a missing SEQUENCE cannot borrow another component's value.
create or replace function calendar_feed_private.compare_revision(incoming jsonb, previous jsonb)
returns integer language plpgsql immutable security invoker set search_path='' as $$
declare a text; b text; field text; comparable boolean:=false;
begin
 foreach field in array array['sequence','dtstamp','lastModified'] loop
   a:=incoming->>field; b:=previous->>field;
   if (a is null) is distinct from (b is null) then return null; end if;
   if a is not null then
     comparable:=true;
     if field='sequence' then
       if a::integer<b::integer then return -1; elsif a::integer>b::integer then return 1; end if;
     else
       if a<b then return -1; elsif a>b then return 1; end if;
     end if;
   end if;
 end loop;
 return case when comparable then 0 else null end;
end $$;

create table if not exists public.calendar_feed_source_revisions (
 id uuid primary key default gen_random_uuid(),
 feed_id uuid not null references public.calendar_feeds(id) on delete cascade,
 external_uid text not null,
 document jsonb not null check(calendar_feed_private.archive_document(document,external_uid)),
 received_at timestamptz not null default clock_timestamp(),
 unique(feed_id,external_uid,id)
);
create table if not exists public.calendar_feed_source_groups (
 feed_id uuid not null references public.calendar_feeds(id) on delete cascade,
 external_uid text not null,
 current_revision_id uuid not null,
 master_cancellation_revision_id uuid,
 materialization_state text not null check(materialization_state in ('ready','needs_revision_review')),
 primary key(feed_id,external_uid),
 foreign key(feed_id,external_uid,current_revision_id) references public.calendar_feed_source_revisions(feed_id,external_uid,id) deferrable initially deferred,
 foreign key(feed_id,external_uid,master_cancellation_revision_id) references public.calendar_feed_source_revisions(feed_id,external_uid,id) deferrable initially deferred
);
create table if not exists public.calendar_feed_source_component_watermarks (
 feed_id uuid not null,
 external_uid text not null,
 component_key text not null,
 version_component jsonb not null,
 version_revision_id uuid not null,
 cancelled_component jsonb,
 cancellation_revision_id uuid,
 primary key(feed_id,external_uid,component_key),
 foreign key(feed_id,external_uid) references public.calendar_feed_source_groups(feed_id,external_uid) on delete cascade,
 foreign key(feed_id,external_uid,version_revision_id) references public.calendar_feed_source_revisions(feed_id,external_uid,id) deferrable initially deferred,
 foreign key(feed_id,external_uid,cancellation_revision_id) references public.calendar_feed_source_revisions(feed_id,external_uid,id) deferrable initially deferred,
 check((cancelled_component is null)=(cancellation_revision_id is null))
);

-- A security-definer endpoint must never bind to an untrusted pre-existing
-- relation/helper or silently accept a differently shaped archive table.
do $$ declare t text; expected jsonb; actual jsonb; begin
 if current_user<>'postgres' then raise exception 'Archive candidate requires trusted postgres migration owner'; end if;
 foreach t in array array['calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks'] loop
   expected:=case t
     when 'calendar_feed_source_revisions' then '{"id":"uuid!","feed_id":"uuid!","external_uid":"text!","document":"jsonb!","received_at":"timestamp with time zone!"}'::jsonb
     when 'calendar_feed_source_groups' then '{"feed_id":"uuid!","external_uid":"text!","current_revision_id":"uuid!","master_cancellation_revision_id":"uuid?","materialization_state":"text!"}'::jsonb
     else '{"feed_id":"uuid!","external_uid":"text!","component_key":"text!","version_component":"jsonb!","version_revision_id":"uuid!","cancelled_component":"jsonb?","cancellation_revision_id":"uuid?"}'::jsonb end;
   select jsonb_object_agg(attname,format_type(atttypid,atttypmod)||case when attnotnull then '!' else '?' end) into actual
     from pg_attribute where attrelid=('public.'||t)::regclass and attnum>0 and not attisdropped;
   if actual is distinct from expected or not exists(select 1 from pg_class where oid=('public.'||t)::regclass and relowner='postgres'::regrole and relkind='r') then
     raise exception 'Incompatible or untrusted source archive table: %',t;
   end if;
 end loop;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='calendar_feed_private' and p.proowner<>'postgres'::regrole)
   or has_schema_privilege('authenticated','calendar_feed_private','CREATE') or has_schema_privilege('service_role','calendar_feed_private','CREATE')
 then raise exception 'Archive helpers require trusted ownership and schema'; end if;
end $$;

create or replace function calendar_feed_private.immutable_archive()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'Source archive revisions are immutable' using errcode='42501'; end $$;
drop trigger if exists calendar_feed_source_revisions_immutable on public.calendar_feed_source_revisions;
create trigger calendar_feed_source_revisions_immutable before update on public.calendar_feed_source_revisions
 for each row execute function calendar_feed_private.immutable_archive();

-- Existing feed UPDATE policy permits members of two families to reparent a
-- legacy feed. Once source history exists, that must not transfer private
-- archive visibility to another family. The feed row lock serializes this
-- trigger with source publication, including service-role callers.
create or replace function calendar_feed_private.prevent_archive_reparent()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.family_id is distinct from old.family_id and exists(select 1 from public.calendar_feed_source_revisions where feed_id=old.id)
 then raise exception 'Archived calendar feed cannot change family' using errcode='42501'; end if;
 return new;
end $$;
drop trigger if exists calendar_feed_archive_family_immutable on public.calendar_feeds;
create trigger calendar_feed_archive_family_immutable before update of family_id on public.calendar_feeds
 for each row execute function calendar_feed_private.prevent_archive_reparent();

do $$ declare t text; r text; begin
 foreach t in array array['calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
   execute format('grant select on public.%I to authenticated,service_role',t);
   execute format('drop policy if exists source_current_members_read on public.%I',t);
   execute format('create policy source_current_members_read on public.%I for select to authenticated using (exists(select 1 from public.calendar_feeds f where f.id=feed_id and public.is_family_member(f.family_id)))',t);
   foreach r in array array['authenticated','service_role'] loop
     if has_table_privilege(r,'public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
       raise exception 'Archive inherited write grants must be removed: %.%',r,t;
     end if;
   end loop;
 end loop;
end $$;

create or replace function public.calendar_feed_archive_sources(p_feed_id uuid,p_fence timestamptz,p_documents jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare invoker text:=current_setting('role',true); actor uuid:=auth.uid(); family uuid; locked_family uuid;
 d jsonb; c jsonb; uid text; key text; revision_id uuid; current_id uuid; old_document jsonb;
 cancel_id uuid; cancel_master jsonb; w public.calendar_feed_source_component_watermarks%rowtype;
 ordering integer; cancel_order integer; review boolean; any_review boolean:=false; reused boolean;
 result jsonb:='[]'; group_state text; known boolean;
begin
 -- SQL role is assigned by the trusted authenticator, not the spoofable JWT
 -- role claim. Service execution is an explicit server-only policy.
 if invoker not in ('authenticated','service_role') or invoker is null then raise exception 'Archive SQL role denied' using errcode='42501'; end if;
 select family_id into family from public.calendar_feeds where id=p_feed_id;
 if not found then return jsonb_build_object('outcome','lost','groups','[]'::jsonb); end if;
 if invoker='authenticated' and (actor is null or not exists(select 1 from public.family_members fm where fm.family_id=family and fm.user_id=actor and fm.is_active))
 then raise exception 'Archive active membership required' using errcode='42501'; end if;
 perform id from public.families where id=family for key share;
 if not found then return jsonb_build_object('outcome','lost','groups','[]'::jsonb); end if;
 if invoker='authenticated' then
   perform id from public.family_members fm where fm.family_id=family and fm.user_id=actor and fm.is_active for share;
   if not found then raise exception 'Archive membership changed' using errcode='42501'; end if;
 end if;
 select family_id into locked_family from public.calendar_feeds where id=p_feed_id and last_status='syncing' and updated_at=p_fence for update;
 if not found then return jsonb_build_object('outcome','lost','groups','[]'::jsonb); end if;
 if locked_family is distinct from family then raise exception 'Archive family changed' using errcode='42501'; end if;
 -- Definer execution must not retire or count corrupt foreign-family rows.
 -- Lock existing rows against concurrent relabeling; the feed FOR UPDATE lock
 -- also fences new inserts through their feed FK's key-share lock.
 perform id from public.calendar_events where feed_id=p_feed_id order by id for update;
 if exists(select 1 from public.calendar_events where feed_id=p_feed_id and family_id is distinct from family)
 then raise exception 'Archive feed contains foreign-family references' using errcode='42501'; end if;
 if jsonb_typeof(p_documents) is distinct from 'array' then raise exception 'Archive array required' using errcode='22023'; end if;
 if jsonb_array_length(p_documents)>2000 or octet_length(p_documents::text)>8388608 then raise exception 'Archive publication limit' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_documents) x group by x->>'uid' having count(*)>1) then raise exception 'Duplicate archive UID' using errcode='22023'; end if;
 for d in select value from jsonb_array_elements(p_documents) order by value->>'uid' loop
   uid:=d->>'uid'; perform calendar_feed_private.archive_document(d,uid);
   current_id:=null; old_document:=null; cancel_id:=null; cancel_master:=null; review:=false;
   select g.current_revision_id,r.document,g.master_cancellation_revision_id into current_id,old_document,cancel_id
     from public.calendar_feed_source_groups g join public.calendar_feed_source_revisions r on r.id=g.current_revision_id
     where g.feed_id=p_feed_id and g.external_uid=uid;
   if cancel_id is not null then select document->'master' into cancel_master from public.calendar_feed_source_revisions where id=cancel_id; end if;
   reused:=old_document is not distinct from d;
   if reused then revision_id:=current_id;
   else insert into public.calendar_feed_source_revisions(feed_id,external_uid,document) values(p_feed_id,uid,d) returning id into revision_id; end if;
   insert into public.calendar_feed_source_groups(feed_id,external_uid,current_revision_id,materialization_state)
     values(p_feed_id,uid,revision_id,'ready') on conflict(feed_id,external_uid) do nothing;
   for c in select value from jsonb_array_elements(d->'overrides') union all select d->'master' where d->'master'<>'null'::jsonb loop
     key:=case when c ? 'recurrenceId' then jsonb_build_array('override',c->'recurrenceId'->>'kind',c->'recurrenceId'->>'tzid',c->'recurrenceId'->>'value')::text else 'master' end;
     select * into w from public.calendar_feed_source_component_watermarks m where m.feed_id=p_feed_id and m.external_uid=uid and m.component_key=key;
     ordering:=null; known:=false;
     if found then
       ordering:=calendar_feed_private.compare_revision(c->'revision',w.version_component->'revision');
       known:=exists(select 1 from jsonb_each(w.version_component->'revision') v where v.key<>'etag' and v.value<>'null'::jsonb);
       if ordering=-1 then raise exception 'Known older archive component: % %',uid,key using errcode='22023'; end if;
       if known and ordering is null then review:=true; end if;
       if ordering=0 and c is distinct from w.version_component then review:=true; end if;
       if w.cancellation_revision_id is not null and c->>'status'<>'cancelled' then
         cancel_order:=calendar_feed_private.compare_revision(c->'revision',w.cancelled_component->'revision');
         if cancel_order is distinct from 1 then review:=true; end if;
       end if;
     else
       if (select count(*) from public.calendar_feed_source_component_watermarks m where m.feed_id=p_feed_id and m.external_uid=uid)>=20000 then raise exception 'Archive watermark identity limit; manual revision review required' using errcode='22023'; end if;
     end if;
     insert into public.calendar_feed_source_component_watermarks(feed_id,external_uid,component_key,version_component,version_revision_id,cancelled_component,cancellation_revision_id)
       values(p_feed_id,uid,key,c,revision_id,case when c->>'status'='cancelled' then c end,case when c->>'status'='cancelled' then revision_id end)
       on conflict(feed_id,external_uid,component_key) do update set
         version_component=case when ordering=1 or not known then c else calendar_feed_source_component_watermarks.version_component end,
         version_revision_id=case when ordering=1 or not known then revision_id else calendar_feed_source_component_watermarks.version_revision_id end,
         cancelled_component=case when c->>'status'='cancelled' then c when cancel_order=1 then null else calendar_feed_source_component_watermarks.cancelled_component end,
         cancellation_revision_id=case when c->>'status'='cancelled' then revision_id when cancel_order=1 then null else calendar_feed_source_component_watermarks.cancellation_revision_id end;
     cancel_order:=null;
   end loop;
   if d->'master'->>'status'='cancelled' then cancel_id:=revision_id; cancel_master:=d->'master';
   elsif cancel_id is not null and d->'master'<>'null'::jsonb and calendar_feed_private.compare_revision(d->'master'->'revision',cancel_master->'revision')=1 then cancel_id:=null; end if;
   if cancel_id is not null and (d->'master'->>'status' in ('confirmed','tentative') or exists(select 1 from jsonb_array_elements(d->'overrides') x where x->>'status'<>'cancelled')) then review:=true; end if;
   -- Absence is not evidence that ANY previously observed original component
   -- was deleted or reactivated, even without SEQUENCE/DTSTAMP. In particular,
   -- dropping a cancelled override must never silently restore its occurrence.
   -- Retain every watermark and require explicit revision reconciliation. A
   -- newer master cannot resolve an omitted detached component's own history.
   if exists(select 1 from public.calendar_feed_source_component_watermarks m
     where m.feed_id=p_feed_id and m.external_uid=uid and not exists(
       select 1 from (
         select 'master' as component_key where d->'master'<>'null'::jsonb
         union all
         select jsonb_build_array('override',x->'recurrenceId'->>'kind',x->'recurrenceId'->>'tzid',x->'recurrenceId'->>'value')::text
           from jsonb_array_elements(d->'overrides') x
       ) current_components where current_components.component_key=m.component_key
     )) then review:=true; end if;
   group_state:=case when review then 'needs_revision_review' else 'ready' end;
   update public.calendar_feed_source_groups set current_revision_id=revision_id,master_cancellation_revision_id=cancel_id,materialization_state=group_state where feed_id=p_feed_id and external_uid=uid;
   -- Source takeover retires only this explicitly supplied UID's legacy rows.
   -- No absent UID is deleted, and no sentinel/projection is invented.
   delete from public.calendar_events where feed_id=p_feed_id and family_id=family and (external_uid=uid or left(external_uid,length(uid)+1)=uid||chr(31));
   any_review:=any_review or review;
   result:=result||jsonb_build_array(jsonb_build_object('uid',uid,'revision_id',revision_id,'state',group_state,'reused',reused));
 end loop;
 any_review:=any_review or exists(select 1 from public.calendar_feed_source_groups where feed_id=p_feed_id and materialization_state='needs_revision_review');
 update public.calendar_feeds set last_status=case when any_review then 'revision_review' else 'ok' end,
   last_error=case when any_review then 'Source revision ordering requires review; materialization is held' else null end,
   last_synced_at=clock_timestamp(),event_count=(select count(*) from public.calendar_events where feed_id=p_feed_id)
   where id=p_feed_id and last_status='syncing' and updated_at=p_fence;
 if not found then raise exception 'Archive settlement refused' using errcode='42501'; end if;
 return jsonb_build_object('outcome',case when any_review then 'needs_revision_review' else 'applied' end,'groups',result);
end $$;
revoke all on function public.calendar_feed_archive_sources(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.calendar_feed_archive_sources(uuid,timestamptz,jsonb) to authenticated,service_role;
revoke all on function calendar_feed_private.archive_document(jsonb,text),calendar_feed_private.compare_revision(jsonb,jsonb),calendar_feed_private.immutable_archive(),calendar_feed_private.prevent_archive_reparent() from public,anon,authenticated,service_role;
comment on function public.calendar_feed_archive_sources(uuid,timestamptz,jsonb) is
 'HELD 0490, source-only, uncalled. Current-membership immutable archive, same-component persistent revision watermarks, exact feed fence and explicit review settlement. Unversioned/incomparable source changes are NOT proved fresh; ready is archive ordering only, NOT qualified occurrence materialization. No raw/typed agreement guarantee.';

-- Pure refusal helper; no table access, privileges, writes or hidden reads.
create or replace function calendar_feed_private.refuse_read(message text, state text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin raise exception '%',message using errcode=state; end $$;
revoke all on function calendar_feed_private.refuse_read(text,text) from public,anon;
grant execute on function calendar_feed_private.refuse_read(text,text) to authenticated,service_role;

-- One statement, one MVCC snapshot: a legacy row and its archive replacement
-- cannot be read on opposite sides of the source takeover commit. ALL family
-- rows are retained for application-side filtering; neither source DTSTART
-- nor recurrence_until safely excludes moved-in exceptions. No app activation.
create or replace function public.calendar_read_occurrence_inputs(p_family_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 with
 auth_gate as materialized (
   select case when p_family_id is not null and (
     current_user='service_role' or (current_user='authenticated' and auth.uid() is not null and public.is_family_member(p_family_id))
   ) then true else calendar_feed_private.refuse_read('Calendar snapshot requires current membership or SQL service role','42501') is null end as allowed
 ),
 native_rows as materialized (
   select e.id,e.recurrence,to_jsonb(e) as payload from public.calendar_events e cross join auth_gate a
   where a.allowed and e.family_id=p_family_id order by e.id limit 20001
 ),
 source_groups as materialized (
   select g.feed_id,g.external_uid,r.id is null as missing_document,
     jsonb_build_object('feedId',g.feed_id,'uid',g.external_uid,'revisionId',g.current_revision_id,
       'materializationState',g.materialization_state,'document',r.document,
       'masterCancellationRevisionId',g.master_cancellation_revision_id,'watermarks','[]'::jsonb) as payload
   from public.calendar_feed_source_groups g join public.calendar_feeds f on f.id=g.feed_id
   cross join auth_gate a
   left join public.calendar_feed_source_revisions r on r.feed_id=g.feed_id and r.external_uid=g.external_uid and r.id=g.current_revision_id
   where a.allowed and f.family_id=p_family_id order by g.feed_id,g.external_uid limit 2001
 ),
 component_watermarks as materialized (
   select w.feed_id,w.external_uid,w.component_key,
     jsonb_build_object('componentKey',w.component_key,'versionComponent',w.version_component,
       'versionRevisionId',w.version_revision_id,'cancelledComponent',w.cancelled_component,
       'cancellationRevisionId',w.cancellation_revision_id) as payload
   from public.calendar_feed_source_component_watermarks w join source_groups g
     on g.feed_id=w.feed_id and g.external_uid=w.external_uid
   order by w.feed_id,w.external_uid,w.component_key limit 40001
 ),
 sizes as materialized (
   select (select count(*) from native_rows) as native_count,
     (select count(*) from native_rows where recurrence is not null and recurrence<>'none') as series_count,
     (select count(*) from source_groups) as source_count,
     (select count(*) from component_watermarks) as watermark_count,
     (select coalesce(bool_or(missing_document),false) from source_groups) as missing_document,
     -- Conservative upper bound of the final JSONB text, before array
     -- aggregation: exact per-object UTF8 bytes, separators and envelope slack.
     (select coalesce(sum(octet_length(payload::text)+2),0) from native_rows)+
     (select coalesce(sum(octet_length(payload::text)+2),0) from source_groups)+
     (select coalesce(sum(octet_length(payload::text)+2),0) from component_watermarks)+1024 as bytes
 ),
 budget as materialized (
   select *,native_count<=20000 and series_count<=2000 and source_count<=2000 and watermark_count<=40000
     and bytes<=8388608 and not missing_document as ok from sizes
 ),
 watermark_arrays as materialized (
   select w.feed_id,w.external_uid,jsonb_agg(w.payload order by w.component_key) as items
   from component_watermarks w cross join budget b where b.ok group by w.feed_id,w.external_uid
 )
 select case
   when b.missing_document then calendar_feed_private.refuse_read('Calendar source current revision is missing or inaccessible','55000')
   when b.native_count>20000 then calendar_feed_private.refuse_read('Calendar snapshot native row count exceeds 20000','54000')
   when b.series_count>2000 then calendar_feed_private.refuse_read('Calendar snapshot series count exceeds 2000','54000')
   when b.source_count>2000 then calendar_feed_private.refuse_read('Calendar snapshot source group count exceeds 2000','54000')
   when b.watermark_count>40000 then calendar_feed_private.refuse_read('Calendar snapshot watermark count exceeds 40000','54000')
   when not b.ok then calendar_feed_private.refuse_read('Calendar snapshot serialized byte bound exceeds 8 MiB','54000')
   else jsonb_build_object('version',1,'familyId',p_family_id,'nativeCount',b.native_count,'sourceCount',b.source_count,'watermarkCount',b.watermark_count,
     'nativeRows',coalesce((select jsonb_agg(n.payload order by n.id) from native_rows n where b.ok),'[]'::jsonb),
     'sourceGroups',coalesce((select jsonb_agg(g.payload||jsonb_build_object('watermarks',coalesce(w.items,'[]'::jsonb)) order by g.feed_id,g.external_uid)
       from source_groups g left join watermark_arrays w on w.feed_id=g.feed_id and w.external_uid=g.external_uid where b.ok),'[]'::jsonb))
   end from auth_gate a cross join budget b where a.allowed;
$$;
revoke all on function public.calendar_read_occurrence_inputs(uuid) from public,anon;
grant execute on function public.calendar_read_occurrence_inputs(uuid) to authenticated,service_role;
comment on function public.calendar_read_occurrence_inputs(uuid) is
 'HELD 0490; uncalled. Version1 complete family native/source inputs in one bounded invoker STABLE SQL statement. Review states preserved, no materialization claim. Missing schema/pointers or limits must fail closed; no production activation authorized.';
