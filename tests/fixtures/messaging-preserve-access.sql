\set ON_ERROR_STOP on
\if :{?keep_fixture}
\else
\set keep_fixture false
\endif
-- Run only in an empty, disposable PostgreSQL database. CREATE TABLE fails
-- before any migration is applied if this is accidentally pointed at an app DB.
-- All identities and history below are synthetic. No storage schema is created.
begin;
create table public.families (
  id uuid primary key default gen_random_uuid(), name text,
  created_by uuid
);
create schema auth;
create table auth.users (id uuid primary key, email text);
alter table public.families add foreign key(created_by) references auth.users(id) on delete set null;
create type public.member_role as enum ('parent','adult','teen','child','caregiver','guest');
create table public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  display_name text not null, role public.member_role not null, is_active boolean not null default true,
  avatar_url text, unique(family_id,user_id)
);
create table public.family_conversations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text, kind text not null default 'group'
    check (kind in ('group', 'direct', 'announcement', 'channel')),
  avatar_emoji text default '💬', member_ids uuid[] not null default '{}',
  participant_ids uuid[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  last_message_at timestamptz, description text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.family_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.family_conversations(id) on delete cascade,
  family_id uuid not null references public.families(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  sender_name text, sender_avatar text, content text,
  kind text not null default 'text'
    check (kind in ('text', 'image', 'file', 'voice', 'poll', 'announcement')),
  attachment_url text, attachment_name text, attachment_mime text,
  reply_to_id uuid references public.family_messages(id) on delete set null,
  reactions jsonb not null default '{}', read_by uuid[] not null default '{}',
  is_pinned boolean not null default false, deleted_at timestamptz,
  created_at timestamptz not null default now()
);
-- Minimal synthetic Storage/notification schemas support the actual composed
-- migrations; no provider or existing application database is used.
create schema storage;
create table storage.buckets(id text primary key, public boolean not null default false, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
alter table storage.objects enable row level security;
create type public.notification_type as enum ('system');
create table public.notifications(id uuid primary key default gen_random_uuid(), family_id uuid not null references public.families(id) on delete cascade,
 user_id uuid references auth.users(id) on delete cascade, type public.notification_type, title text, body text,
 related_type text, related_id text, is_read boolean not null default false);
alter table public.notifications enable row level security;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
create function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function auth.role() returns text language sql stable set search_path = '' as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;
create function public.is_family_member(p_family_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and is_active);
$$;
create function public.can_manage_family(p_family_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and is_active
      and role in ('parent', 'adult'));
$$;
create function public.is_family_admin(p_family_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and is_active and role = 'parent');
$$;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_conversations enable row level security;
alter table public.family_messages enable row level security;
create policy fm_select on public.family_members for select to authenticated
  using (public.is_family_member(family_id));
-- Main's 0118 family SELECT/DELETE policies; authenticated cleanup must exercise
-- the actual parent policy, rather than inherit this fixture connection's role.
create policy families_select on public.families for select
  using (public.is_family_member(id));
create policy families_delete on public.families for delete
  using (public.is_family_admin(id));
grant usage on schema public, auth, storage to authenticated, anon, service_role;
grant all on storage.objects,storage.buckets to service_role;
grant select,insert,update,delete on storage.objects to authenticated;
grant select on public.notifications to authenticated;
grant update(is_read) on public.notifications to authenticated;
grant all on public.notifications to service_role;
create policy notification_recipient_read on public.notifications for select to authenticated using(user_id=auth.uid());
create policy notification_recipient_update on public.notifications for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant execute on all functions in schema auth, public to authenticated, anon, service_role;
grant select on public.family_members to authenticated, anon;
grant update, delete on public.family_members to authenticated;
create policy fm_delete on public.family_members for delete using(public.can_manage_family(family_id));
grant select, delete on public.families to authenticated;
grant all on public.family_conversations, public.family_messages to authenticated, anon, service_role;
grant all on public.families, public.family_members, auth.users to service_role;
-- The production metadata trigger remains a definer and runs during an
-- authenticated send; its harmless timestamp update must remain possible.
create function public.update_conversation_last_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.family_conversations set last_message_at = new.created_at, updated_at = now()
    where id = new.conversation_id;
  return new;
end $$;
create trigger trg_update_conversation_last_message after insert on public.family_messages
  for each row execute function public.update_conversation_last_message();
\ir ../../supabase/migrations/0163_messages_audio_read_fix.sql
\ir ../../supabase/migrations/0367_a_message_is_its_senders.sql
\ir ../../supabase/migrations/0368_a_conversation_is_not_anyones_to_wipe.sql
\ir ../../supabase/migrations/0463_a_read_receipt_is_the_readers_own.sql
-- Exercise the actual membership lifecycle, not a trigger-free stand-in.
-- This remains a focused synthetic schema rather than an all-migrations replay.
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
\ir ../../supabase/migrations/0134_model_dirty.sql
\ir ../../supabase/migrations/0211_family_members_update_rls.sql
\ir ../../supabase/migrations/0249_model_dirty_delete_safe.sql
\ir ../../supabase/migrations/0283_assistant_links.sql
\ir ../../supabase/migrations/0299_family_keeps_a_manager.sql
\ir ../../supabase/migrations/0343_only_a_parent_mints_or_revokes_an_assistant_key.sql
\ir ../../supabase/migrations/0419_a_departed_parent_keeps_no_assistant_key.sql
\ir ../../supabase/migrations/0458_only_the_server_links_a_login_to_a_member.sql

create schema fixture;
create table fixture.ids (key text primary key, id uuid not null unique);
insert into fixture.ids values
  ('family', 'aa000000-0000-4000-8000-000000000001'),
  ('other-family', 'aa000000-0000-4000-8000-000000000002'),
  ('cleanup-family', 'aa000000-0000-4000-8000-000000000003'),
  ('alice', 'ab000000-0000-4000-8000-000000000001'),
  ('bob', 'ab000000-0000-4000-8000-000000000002'),
  ('parent', 'ab000000-0000-4000-8000-000000000003'),
  ('eve', 'ab000000-0000-4000-8000-000000000004'),
  ('cross', 'ab000000-0000-4000-8000-000000000005'),
  ('newcomer', 'ab000000-0000-4000-8000-000000000006'),
  ('alice-member', 'ac000000-0000-4000-8000-000000000001'),
  ('bob-member', 'ac000000-0000-4000-8000-000000000002'),
  ('parent-member', 'ac000000-0000-4000-8000-000000000003'),
  ('eve-member', 'ac000000-0000-4000-8000-000000000004'),
  ('cross-member', 'ac000000-0000-4000-8000-000000000005'),
  ('newcomer-member', 'ac000000-0000-4000-8000-000000000006'),
  ('managed-member', 'ac000000-0000-4000-8000-000000000007'),
  ('cleanup-member', 'ac000000-0000-4000-8000-000000000008'),
  ('mixed', 'ad000000-0000-4000-8000-000000000001'),
  ('member-only', 'ad000000-0000-4000-8000-000000000002'),
  ('empty-roster', 'ad000000-0000-4000-8000-000000000003'),
  ('legacy-full', 'ad000000-0000-4000-8000-000000000004'),
  ('foreign', 'ad000000-0000-4000-8000-000000000005'),
  ('restricted', 'ad000000-0000-4000-8000-000000000006'),
  ('cleanup-conversation', 'ad000000-0000-4000-8000-000000000007'),
  ('mixed-message', 'ae000000-0000-4000-8000-000000000001'),
  ('member-only-message', 'ae000000-0000-4000-8000-000000000002'),
  ('empty-roster-message', 'ae000000-0000-4000-8000-000000000003'),
  ('legacy-full-message', 'ae000000-0000-4000-8000-000000000004'),
  ('foreign-message', 'ae000000-0000-4000-8000-000000000005'),
  ('restricted-message', 'ae000000-0000-4000-8000-000000000006'),
  ('deleted-message', 'ae000000-0000-4000-8000-000000000007'),
  ('policy-blocked-message', 'ae000000-0000-4000-8000-000000000008'),
  ('poisoned-family-message', 'ae000000-0000-4000-8000-000000000009'),
  ('cleanup-message', 'ae000000-0000-4000-8000-000000000010');
create function fixture.id(p_key text) returns uuid language sql stable
set search_path = '' as $$ select id from fixture.ids where key = p_key; $$;
create function fixture.assert_true(p_condition boolean, p_label text) returns void
language plpgsql set search_path = '' as $$
begin
  if p_condition is distinct from true then raise exception 'FAIL: %', p_label; end if;
end $$;
create function fixture.expect_blocked(p_sql text, p_label text) returns void
language plpgsql set search_path = '' as $$
declare affected integer;
begin
  begin
    execute p_sql;
    get diagnostics affected = row_count;
    if affected <> 0 then raise exception 'FAIL: % changed % rows', p_label, affected; end if;
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;
create function fixture.expect_unreadable(p_sql text, p_label text) returns void
language plpgsql set search_path = '' as $$
declare visible integer;
begin
  begin
    execute p_sql into visible;
    perform fixture.assert_true(visible = 0, p_label);
  exception when insufficient_privilege then null;
  end;
end $$;
grant usage on schema fixture to authenticated, anon, service_role;
grant select on fixture.ids to authenticated, anon, service_role;
grant execute on all functions in schema fixture to authenticated, anon, service_role;
insert into auth.users(id, email)
  select id, key || '@example.invalid' from fixture.ids
    where key in ('alice', 'bob', 'parent', 'eve', 'cross', 'newcomer');
insert into public.families(id, name, created_by) values
  (fixture.id('family'), 'Synthetic family', fixture.id('alice')),
  (fixture.id('other-family'), 'Synthetic other family', fixture.id('cross'));
insert into public.family_members(id, family_id, user_id, display_name, role) values
  (fixture.id('alice-member'), fixture.id('family'), fixture.id('alice'), 'Alice', 'adult'),
  (fixture.id('bob-member'), fixture.id('family'), fixture.id('bob'), 'Bob', 'child'),
  (fixture.id('parent-member'), fixture.id('family'), fixture.id('parent'), 'Parent outsider', 'parent'),
  (fixture.id('eve-member'), fixture.id('family'), fixture.id('eve'), 'Eve outsider', 'child'),
  (fixture.id('cross-member'), fixture.id('other-family'), fixture.id('cross'), 'Other family', 'adult'),
  (fixture.id('managed-member'), fixture.id('family'), null, 'Managed child', 'child');
insert into public.family_conversations(id, family_id, name, kind, member_ids, participant_ids, created_by) values
  (fixture.id('mixed'), fixture.id('family'), 'Mixed legacy roster', 'group',
    array[fixture.id('bob')], array[fixture.id('alice-member')], fixture.id('alice')),
  (fixture.id('member-only'), fixture.id('family'), 'Legacy account roster', 'direct',
    array[fixture.id('bob')], '{}', fixture.id('bob')),
  (fixture.id('empty-roster'), fixture.id('family'), 'Legacy empty roster', 'group',
    '{}', '{}', fixture.id('alice')),
  (fixture.id('legacy-full'), fixture.id('family'), 'Family Chat', 'group',
    array[fixture.id('alice'), fixture.id('bob'), fixture.id('parent'), fixture.id('eve')],
    array[fixture.id('alice-member'), fixture.id('bob-member'), fixture.id('parent-member'),
      fixture.id('eve-member'), fixture.id('managed-member')], fixture.id('alice')),
  (fixture.id('foreign'), fixture.id('other-family'), 'Other family history', 'group',
    array[fixture.id('cross')], array[fixture.id('cross-member')], fixture.id('cross')),
  (fixture.id('restricted'), fixture.id('family'), 'Restricted Chat', 'group',
    array[fixture.id('alice')], array[fixture.id('alice-member')], fixture.id('alice'));
insert into public.family_messages(id, conversation_id, family_id, sender_id, content) values
  (fixture.id('mixed-message'), fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Private old mixed history'),
  (fixture.id('member-only-message'), fixture.id('member-only'), fixture.id('family'), fixture.id('bob'), 'Private old account history'),
  (fixture.id('empty-roster-message'), fixture.id('empty-roster'), fixture.id('family'), fixture.id('alice'), 'Creator-only old history'),
  (fixture.id('legacy-full-message'), fixture.id('legacy-full'), fixture.id('family'), fixture.id('alice'), 'Old household history'),
  (fixture.id('foreign-message'), fixture.id('foreign'), fixture.id('other-family'), fixture.id('cross'), 'Other family old history'),
  (fixture.id('restricted-message'), fixture.id('restricted'), fixture.id('family'), fixture.id('alice'), 'Restricted old history'),
  (fixture.id('deleted-message'), fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Deleted reply target'),
  (fixture.id('policy-blocked-message'), fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'blocked by retained policy'),
  -- Main's independent foreign keys allow this legacy mismatch. A new SELECT
  -- policy must match both family columns rather than grant either family access.
  (fixture.id('poisoned-family-message'), fixture.id('mixed'), fixture.id('other-family'), fixture.id('cross'), 'Mismatched legacy family');
update public.family_messages set deleted_at = now() where id = fixture.id('deleted-message');
create table fixture.legacy_conversations as select * from public.family_conversations;
create table fixture.legacy_messages as select * from public.family_messages;
create policy retained_conversation_limit on public.family_conversations as restrictive for all to authenticated
  using (name is distinct from 'Restricted Chat') with check (name is distinct from 'Restricted Chat');
create policy retained_message_limit on public.family_messages as restrictive for all to authenticated
  using (content is distinct from 'blocked by retained policy')
  with check (content is distinct from 'blocked by retained policy');
-- An earlier candidate exported a one-argument RPC that could adopt legacy
-- history. Exact overload resolution would keep choosing it over the new
-- defaulted three-argument function unless both old signatures are retired.
create schema messaging_private;
create function messaging_private.ensure_family_conversation(p_family_id uuid)
returns uuid language sql security definer set search_path = '' as $$
  select id from public.family_conversations where family_id = p_family_id order by created_at, id limit 1;
$$;
create function public.ensure_family_conversation(p_family_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select messaging_private.ensure_family_conversation(p_family_id);
$$;
\ir ../../supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql
\ir ../../supabase/migrations/0476_messaging_notifications_preferences.sql
\ir ../../supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql
\ir ../../supabase/migrations/0476_messaging_notifications_preferences.sql
select fixture.assert_true((select count(*)=2 from pg_trigger where tgrelid='public.family_members'::regclass
  and tgname in ('trg_family_members_scope_lock','trg_family_members_parent_lock') and tgenabled='O'),
  'both membership parent-order triggers survive repeated application');

-- No migration rewrites, promotes, archives or deletes any existing history.
select fixture.assert_true(not exists (
  select 1 from public.family_conversations c join fixture.legacy_conversations old using(id)
  where (to_jsonb(c) - 'is_family_chat') is distinct from to_jsonb(old) or c.is_family_chat
), 'all existing conversation identities, rosters and metadata are preserved');
select fixture.assert_true(not exists (
  select 1 from public.family_messages m join fixture.legacy_messages old using(id)
  where (to_jsonb(m) - 'edited_at' - 'idempotency_key') is distinct from to_jsonb(old)
), 'all existing history is preserved');
select fixture.assert_true((select count(*) = 2 from pg_policies
  where schemaname = 'public' and policyname in ('retained_conversation_limit', 'retained_message_limit')
    and permissive = 'RESTRICTIVE'), 'existing restrictive policies survive both applications');
select fixture.assert_true((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'messaging_private') and p.proname = 'ensure_family_conversation' and p.pronargs = 1),
  'both unsafe one-argument canonical overloads are retired');
select fixture.assert_true((select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'messaging_private') and p.proname = 'ensure_family_conversation'
    and p.pronargs = 3 and p.pronargdefaults = 2), 'only current defaulted canonical signatures remain');

do $$
declare canonical uuid; second uuid; affected integer;
begin
  perform set_config('request.jwt.claim.sub', fixture.id('alice')::text, true);
  set local role authenticated;
  perform fixture.assert_true((select count(*) = 1 from public.family_conversations where id = fixture.id('mixed')),
    'participant_ids Alice retains mixed-roster access');
  perform fixture.assert_true((select count(*) = 1 from public.family_messages where id = fixture.id('mixed-message')),
    'participant_ids Alice reads original history');
  perform fixture.assert_true((select count(*) = 1 from public.family_conversations where id = fixture.id('empty-roster')),
    'both-empty legacy roster remains creator-only');
  perform fixture.assert_true((select count(*) = 0 from public.family_conversations where id = fixture.id('member-only')),
    'creator of another thread has no access to Bob-only history');
  perform fixture.assert_true((select count(*) = 0 from public.family_conversations where id = fixture.id('restricted')),
    'a retained restrictive conversation policy still denies a real participant');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages where id = fixture.id('restricted-message')),
    'a retained conversation policy also hides that thread history');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages where id = fixture.id('policy-blocked-message')),
    'a retained restrictive message policy still denies a real participant');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages where id = fixture.id('poisoned-family-message')),
    'participant cannot read a message stamped with another family');
  canonical := public.ensure_family_conversation(fixture.id('family'));
  second := public.ensure_family_conversation(fixture.id('family'));
  perform fixture.assert_true(canonical = second and canonical <> fixture.id('legacy-full')
    and canonical <> fixture.id('mixed'), 'ensure creates one new chat and never adopts any old group');
  perform fixture.assert_true((select count(*) = 1 from public.family_conversations
    where family_id = fixture.id('family') and is_family_chat), 'exactly one canonical Family Chat');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages where conversation_id = canonical),
    'new canonical chat starts without adopted history');
  insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Allowed participant send');
  get diagnostics affected = row_count;
  perform fixture.assert_true(affected = 1, 'participant can actually send');
  perform fixture.assert_true((select last_message_at is not null from public.family_conversations where id = fixture.id('mixed')),
    'sender insert still runs the definer metadata trigger');
  insert into public.family_messages(conversation_id, family_id, sender_id, content, reply_to_id)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Allowed same-thread reply', fixture.id('mixed-message'));
  update public.family_messages set content = 'Own corrected text' where id = fixture.id('mixed-message');
  get diagnostics affected = row_count;
  perform fixture.assert_true(affected = 1, 'sender can edit their own original text');
  perform fixture.expect_blocked($q$update public.family_conversations set
    participant_ids = array[fixture.id('alice-member'), fixture.id('eve-member')]
    where id = fixture.id('mixed')$q$, 'creator cannot add a reader to existing history');
  perform fixture.expect_blocked($q$update public.family_conversations set member_ids = array[fixture.id('alice')]
    where id = fixture.id('mixed')$q$, 'creator cannot remove legacy account-roster access');
  perform fixture.expect_blocked($q$update public.family_conversations set is_family_chat = true
    where id = fixture.id('legacy-full')$q$, 'ordinary history cannot be promoted to canonical');
  perform fixture.expect_blocked($q$update public.family_conversations set family_id = fixture.id('other-family')
    where id = fixture.id('mixed')$q$, 'conversation family cannot be moved');
  perform fixture.expect_blocked($q$update public.family_conversations set created_by = fixture.id('parent')
    where id = fixture.id('mixed')$q$, 'conversation creator cannot be changed');
  perform fixture.expect_blocked($q$update public.family_conversations set kind = 'direct'
    where id = fixture.id('mixed')$q$, 'conversation kind cannot change');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(fixture.id('mixed'), fixture.id('other-family'), fixture.id('alice'), 'Wrong message family')$q$,
    'message and conversation families must match');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('bob'), 'Forged sender')$q$, 'sender impersonation denied');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content, reply_to_id)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Wrong-thread reply', fixture.id('legacy-full-message'))$q$,
    'reply cannot name another accessible conversation');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content, reply_to_id)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Foreign reply', fixture.id('foreign-message'))$q$,
    'reply cannot name another family');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content, reply_to_id)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Deleted reply', fixture.id('deleted-message'))$q$,
    'reply cannot name a soft-deleted message');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content, read_by)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('alice'), 'Forged receipt', array[fixture.id('bob')])$q$,
    'main receipt guard survives and blocks insertion in another reader name');
  perform fixture.expect_blocked($q$insert into public.family_conversations(family_id, name, kind, member_ids, participant_ids, created_by, is_family_chat)
    values(fixture.id('family'), 'Forged canonical', 'group', array[fixture.id('alice')], array[fixture.id('alice-member')], fixture.id('alice'), true)$q$,
    'only the RPC can set the canonical flag');
  perform public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'),
    fixture.id('alice'), 'Authenticated RPC participant send', 'text', fixture.id('mixed-message'));
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('bob-member'), fixture.id('bob'), 'Forged RPC actor')$q$, 'authenticated RPC cannot impersonate another active participant');
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('restricted'),
    fixture.id('alice-member'), fixture.id('alice'), 'Restricted thread RPC send')$q$,
    'RPC honors restrictive conversation policy even for listed participant');
  reset role;
end $$;

-- Retry lookup is an authorized read with an exact natural match. The empty
-- result must be zero rows rather than a fabricated all-null composite record.
do $$ declare sent public.family_messages; duplicate public.family_messages; found_id uuid; begin
  perform set_config('request.jwt.claim.sub', fixture.id('alice')::text, true);
  set local role authenticated;
  sent := public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'),
    fixture.id('alice'), 'Exact synthetic retry', 'announcement', fixture.id('mixed-message'));
  select id into found_id from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Exact synthetic retry', 'announcement',
    fixture.id('mixed-message'), now() - interval '10 minutes');
  perform fixture.assert_true(found_id = sent.id, 'retry lookup returns the exact visible sender, kind and reply match');
  duplicate := public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'),
    fixture.id('alice'), 'Exact synthetic retry', 'announcement', fixture.id('mixed-message'));
  select id into found_id from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Exact synthetic retry', 'announcement',
    fixture.id('mixed-message'), now() - interval '10 minutes');
  perform fixture.assert_true(sent.created_at = duplicate.created_at and found_id = greatest(sent.id, duplicate.id)
    and (select count(*) = 1 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
      fixture.id('alice-member'), fixture.id('alice'), 'Exact synthetic retry', 'announcement',
      fixture.id('mixed-message'), now() - interval '10 minutes')),
    'equal-time duplicate retry matches produce one deterministic newest ID');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Exact synthetic retry', 'text', fixture.id('mixed-message'),
    now() - interval '10 minutes')), 'retry lookup cannot confuse message kinds');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Exact synthetic retry', 'announcement', null,
    now() - interval '10 minutes')), 'retry lookup distinguishes a reply from a null reply');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'No such synthetic retry', 'text', null,
    now() - interval '10 minutes')), 'a missing retry returns zero rows');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Exact synthetic retry', 'announcement', fixture.id('mixed-message'),
    now() + interval '1 second')), 'retry lookup enforces its caller supplied time window');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'blocked by retained policy', 'text', null,
    '-infinity'::timestamptz)), 'retry lookup retains restrictive message visibility');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Deleted reply target', 'text', null,
    '-infinity'::timestamptz)), 'retry lookup never returns deleted message history');
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('restricted'),
    fixture.id('alice-member'), fixture.id('alice'), 'Restricted old history', 'text', null,
    '-infinity'::timestamptz)$q$, 'retry lookup retains restrictive conversation visibility');
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('bob-member'), fixture.id('bob'), 'Private old mixed history', 'text', null,
    '-infinity'::timestamptz)$q$, 'authenticated retry lookup cannot forge another acting participant');
  reset role;
end $$;

-- Exercise the audience trigger itself, independently of the column grants.
-- Restore the migration's grants immediately after this synthetic broadening.
grant update(id, family_id, created_by, kind, is_family_chat, member_ids, participant_ids)
  on public.family_conversations to authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', fixture.id('alice')::text, true);
  set local role authenticated;
  perform fixture.expect_blocked($q$update public.family_conversations set
    participant_ids = array[fixture.id('alice-member'), fixture.id('eve-member')]
    where id = fixture.id('mixed')$q$, 'audience trigger itself rejects adding a history reader');
  perform fixture.expect_blocked($q$update public.family_conversations set member_ids = array[fixture.id('alice')]
    where id = fixture.id('mixed')$q$, 'audience trigger itself preserves mixed legacy account grants');
  perform fixture.expect_blocked($q$update public.family_conversations set created_by = fixture.id('parent')
    where id = fixture.id('mixed')$q$, 'identity trigger itself rejects changing the creator');
  perform fixture.expect_blocked($q$update public.family_conversations set kind = 'direct'
    where id = fixture.id('mixed')$q$, 'identity trigger itself rejects changing kind');
  perform fixture.expect_blocked($q$update public.family_conversations set is_family_chat = false
    where family_id = fixture.id('family') and is_family_chat$q$, 'identity trigger itself preserves the canonical flag');
  reset role;
end $$;
revoke update(id, family_id, created_by, kind, is_family_chat, member_ids, participant_ids)
  on public.family_conversations from authenticated;

do $$ declare affected integer; begin
  perform set_config('request.jwt.claim.sub', fixture.id('bob')::text, true);
  set local role authenticated;
  perform fixture.assert_true((select count(*) = 1 from public.family_conversations where id = fixture.id('mixed')),
    'member_ids Bob retains access even when participant_ids names someone else');
  perform fixture.assert_true((select count(*) = 1 from public.family_messages where id = fixture.id('mixed-message')),
    'member_ids Bob still reads original mixed-roster history');
  perform fixture.assert_true((select count(*) = 1 from public.family_messages where id = fixture.id('member-only-message')),
    'legacy member_ids-only history remains readable');
  perform fixture.assert_true((select count(*) = 0 from public.family_conversations where id = fixture.id('empty-roster')),
    'empty roster grants no access to another active family member');
  insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('bob'), 'Bob can send from legacy roster');
  perform public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('bob-member'),
    fixture.id('bob'), 'Child participant RPC send');
  perform fixture.assert_true((select count(*) = 1 from public.family_messages
    where conversation_id = fixture.id('mixed') and content = 'Child participant RPC send'),
    'child participant RPC works without creator or manager UPDATE authority');
  perform fixture.expect_blocked($q$update public.family_messages set content = 'Forged edit'
    where id = fixture.id('mixed-message')$q$, 'main sender guard still blocks participant editing another sender text');
  perform fixture.expect_blocked($q$delete from public.family_messages where id = fixture.id('mixed-message')$q$,
    'main sender policy still blocks hard deletion by another participant');
  update public.family_messages set is_pinned = true where id = fixture.id('mixed-message');
  get diagnostics affected = row_count;
  perform fixture.assert_true(affected = 1, 'participant can still pin another sender message');
  perform public.mark_conversation_read(fixture.id('mixed'));
  perform fixture.assert_true((select read_by @> array[fixture.id('bob')] from public.family_messages
    where id = fixture.id('mixed-message')), 'invoker read-receipt RPC still works for actual participants');
  perform fixture.expect_blocked($q$update public.family_messages set read_by = array[fixture.id('alice')]
    where id = fixture.id('mixed-message')$q$, 'participant cannot forge another reader receipt');
  perform fixture.expect_blocked($q$update public.family_messages set reactions = jsonb_build_object('👍', jsonb_build_array(fixture.id('alice')::text))
    where id = fixture.id('mixed-message')$q$, 'participant cannot forge another reader reaction');
  reset role;
end $$;

-- All outsider roles are denied the same private audience. Being a parent
-- does not independently grant access to a private conversation.
do $$ declare who text; begin
  foreach who in array array['parent', 'eve', 'cross'] loop
    perform set_config('request.jwt.claim.sub', fixture.id(who)::text, true);
    set local role authenticated;
    perform fixture.assert_true((select count(*) = 0 from public.family_conversations where id = fixture.id('mixed')),
      who || ' cannot read private conversation');
    perform fixture.assert_true((select count(*) = 0 from public.family_messages where conversation_id = fixture.id('mixed')),
      who || ' cannot read private history');
    perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content)
      values(fixture.id('mixed'), fixture.id('family'), auth.uid(), 'Outsider send')$q$, who || ' cannot send');
    perform fixture.expect_blocked($q$update public.family_messages set is_pinned = true
      where id = fixture.id('mixed-message')$q$, who || ' cannot mutate private history');
    perform fixture.expect_blocked($q$delete from public.family_conversations where id = fixture.id('mixed')$q$,
      who || ' cannot delete private conversation by cascade');
    perform fixture.expect_blocked(format($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
      fixture.id(%L), fixture.id(%L), 'Outsider RPC send')$q$, who || '-member', who), who || ' cannot send through RPC');
    perform public.mark_conversation_read(fixture.id('mixed'));
    reset role;
  end loop;
end $$;
select fixture.assert_true((select read_by = array[fixture.id('bob')] from public.family_messages
  where id = fixture.id('mixed-message')), 'outsider read RPC changed no receipt');
select fixture.assert_true((select count(*) = 1 from public.family_conversations where id = fixture.id('mixed')),
  'outsider parent-cascade attempts preserved private thread');

insert into public.family_members(id, family_id, user_id, display_name, role)
  values(fixture.id('newcomer-member'), fixture.id('family'), fixture.id('newcomer'), 'Future member', 'child');
do $$ declare canonical uuid; begin
  perform set_config('request.jwt.claim.sub', fixture.id('newcomer')::text, true);
  set local role authenticated;
  canonical := public.ensure_family_conversation(fixture.id('family'));
  perform fixture.assert_true((select count(*) = 1 from public.family_conversations where id = canonical and is_family_chat),
    'future active member can open the canonical whole-family chat');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages
    where conversation_id in (fixture.id('mixed'), fixture.id('member-only'), fixture.id('empty-roster'), fixture.id('legacy-full'))),
    'future active member gains none of the original group history');
  insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(canonical, fixture.id('family'), fixture.id('newcomer'), 'Future member can send to new Family Chat');
  reset role;
end $$;
update public.family_members set is_active = false where id = fixture.id('bob-member');
do $$ begin
  perform set_config('request.jwt.claim.sub', fixture.id('bob')::text, true);
  set local role authenticated;
  perform fixture.assert_true((select count(*) = 0 from public.family_conversations where family_id = fixture.id('family')),
    'deactivated participant loses all conversation access');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages where family_id = fixture.id('family')),
    'deactivated participant loses all history access');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(fixture.id('mixed'), fixture.id('family'), fixture.id('bob'), 'Removed participant send')$q$,
    'deactivated participant cannot send with retained auth identity');
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('bob-member'), fixture.id('bob'), 'Removed RPC send')$q$, 'deactivated participant cannot send through RPC');
  reset role;
end $$;
update public.family_members set is_active = true where id = fixture.id('bob-member');

-- A creator still owns deletion of their ordinary chat; the dependent message
-- cascade must run the membership guard instead of rejecting all nested work.
do $$ declare owned uuid; affected integer; begin
  perform set_config('request.jwt.claim.sub', fixture.id('alice')::text, true);
  set local role authenticated;
  insert into public.family_conversations(family_id, name, kind, member_ids, participant_ids, created_by)
    values(fixture.id('family'), 'Synthetic owned cleanup', 'group', array[fixture.id('alice'), fixture.id('bob')],
      array[fixture.id('alice-member'), fixture.id('bob-member')], fixture.id('alice')) returning id into owned;
  insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(owned, fixture.id('family'), fixture.id('alice'), 'Owned cleanup history');
  delete from public.family_conversations where id = owned;
  get diagnostics affected = row_count;
  perform fixture.assert_true(affected = 1, 'authorized creator can delete their ordinary chat');
  perform fixture.assert_true((select count(*) = 0 from public.family_messages where conversation_id = owned),
    'authorized parent-conversation cascade removes dependent history');
  reset role;
end $$;
do $$ begin
  perform set_config('request.jwt.claim.sub', fixture.id('bob')::text, true);
  set local role authenticated;
  perform fixture.assert_true((select count(*) = 1 from public.family_messages where id = fixture.id('mixed-message')),
    'reactivation restores original mixed roster history without roster rewrite');
  perform fixture.assert_true((select count(*) = 1 from public.family_messages where id = fixture.id('member-only-message')),
    'reactivation restores original member_ids-only history');
  reset role;
end $$;

do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  perform fixture.expect_unreadable('select count(*) from public.family_conversations', 'anonymous reads no conversations');
  perform fixture.expect_unreadable('select count(*) from public.family_messages', 'anonymous reads no messages');
  perform fixture.expect_blocked($q$insert into public.family_messages(conversation_id, family_id, sender_id, content)
    values(fixture.id('mixed'), fixture.id('family'), null, 'Anonymous send')$q$, 'anonymous cannot send');
  begin
    perform public.ensure_family_conversation(fixture.id('family'));
    raise exception 'FAIL: anonymous canonical RPC was executable';
  exception when insufficient_privilege then null;
  end;
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('alice'), 'Own corrected text', 'text', null,
    '-infinity'::timestamptz)$q$, 'anonymous cannot execute the private-history retry lookup');
  reset role;
end $$;

-- An elevated client must prove the acting person's membership and audience.
-- These are real SQL roles, not a mocked interpretation of a JWT role claim.
do $$ declare canonical uuid; result public.family_messages; begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
  canonical := public.ensure_family_conversation(fixture.id('family'));
  result := public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'),
    fixture.id('alice'), 'Elevated RPC checks the participant');
  perform fixture.assert_true(result.sender_id = fixture.id('alice') and result.conversation_id = fixture.id('mixed'),
    'service role can send only as its verified real participant');
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('bob'), 'Wrong actor user')$q$, 'elevated RPC rejects a membership and user mismatch');
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('parent-member'), fixture.id('parent'), 'Parent outsider via service')$q$,
    'elevated RPC rejects a private outsider despite their parent role');
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('cross-member'), fixture.id('cross'), 'Cross-family actor via service')$q$,
    'elevated RPC rejects another family actor');
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    null, null, 'System actor in private chat')$q$, 'system actor may not send into private old history');
  result := public.send_family_message(fixture.id('family'), canonical, null, null, 'System canonical reminder');
  perform fixture.assert_true(result.sender_id is null and result.conversation_id = canonical,
    'system actor can address only the new whole-family chat');
  perform fixture.assert_true((select count(*) = 1 from public.find_family_message(fixture.id('family'), canonical,
    null, null, 'System canonical reminder', 'text', null, now() - interval '10 minutes')),
    'system retry lookup exactly matches a null sender and null reply in the canonical chat');
  perform fixture.assert_true((select count(*) = 0 from public.find_family_message(fixture.id('family'), canonical,
    fixture.id('alice-member'), fixture.id('alice'), 'System canonical reminder', 'text', null,
    now() - interval '10 minutes')), 'retry lookup cannot confuse a null system sender with a real sender');
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    null, null, 'Own corrected text', 'text', null, '-infinity'::timestamptz)$q$,
    'system retry lookup cannot read private old history');
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('parent-member'), fixture.id('parent'), 'Own corrected text', 'text', null,
    '-infinity'::timestamptz)$q$, 'elevated retry lookup rejects a private outsider despite their parent role');
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('alice-member'), fixture.id('bob'), 'Own corrected text', 'text', null,
    '-infinity'::timestamptz)$q$, 'elevated retry lookup rejects a membership and user mismatch');
  reset role;
end $$;
update public.family_members set is_active = false where id = fixture.id('bob-member');
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('bob-member'), fixture.id('bob'), 'Inactive actor via service')$q$,
    'elevated RPC rejects an inactive acting participant');
  perform fixture.expect_blocked($q$select public.ensure_family_conversation(fixture.id('family'),
    fixture.id('bob-member'), fixture.id('bob'))$q$, 'elevated canonical ensure rejects an inactive explicit actor even for an existing chat');
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('bob-member'), fixture.id('bob'), 'Member-only old history', 'text', null,
    '-infinity'::timestamptz)$q$, 'elevated retry lookup rejects an inactive explicit actor');
  reset role;
  perform set_config('request.jwt.claim.sub', fixture.id('bob')::text, true);
  set local role authenticated;
  perform fixture.expect_blocked($q$select * from public.find_family_message(fixture.id('family'), fixture.id('mixed'),
    fixture.id('bob-member'), fixture.id('bob'), 'Member-only old history', 'text', null,
    '-infinity'::timestamptz)$q$, 'authenticated retry lookup rejects an inactive participant');
  reset role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role authenticated;
  perform fixture.expect_blocked($q$select public.send_family_message(fixture.id('family'), fixture.id('mixed'),
    null, null, 'Forged service claim')$q$, 'a JWT role claim does not grant service SQL authority');
  reset role;
end $$;
update public.family_members set is_active = true where id = fixture.id('bob-member');

-- Ordinary membership deactivation still runs the dirty marker and assistant
-- retirement, and leaves another manager for the deferred main0299 constraint.
do $$ begin
  perform set_config('request.jwt.claim.sub',fixture.id('bob')::text,true);
  set local role authenticated;
  perform fixture.expect_blocked($q$update public.family_members set role='parent' where id=fixture.id('bob-member')$q$,
    'a child cannot promote their own membership');
  reset role;
  perform set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
  set local role authenticated;
  perform fixture.expect_blocked($q$update public.family_members set display_name='Foreign mutation' where id=fixture.id('cross-member')$q$,
    'a primary-family parent cannot edit a foreign membership');
  reset role;
  perform fixture.assert_true((select display_name='Other family' from public.family_members where id=fixture.id('cross-member')),
    'the foreign membership remains present and unchanged');
  perform set_config('request.jwt.claim.sub','',true);
  update public.family_members set is_active=false where id=fixture.id('parent-member');
  perform set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
  set local role authenticated;
  perform fixture.expect_blocked($q$update public.family_members set is_active=true where id=fixture.id('parent-member')$q$,
    'an inactive parent cannot reactivate their own membership');
  reset role;
  perform fixture.assert_true((select not is_active from public.family_members where id=fixture.id('parent-member')),
    'inactive-parent refusal is checked against an actual retained row');
  perform set_config('request.jwt.claim.sub','',true);
  update public.family_members set is_active=true where id=fixture.id('parent-member');
end $$;

-- Preserve server-side onboarding's linked-member insert/upsert path.
do $$ begin
  begin
    perform set_config('request.jwt.claim.sub','',true);
    insert into auth.users(id,email) values('ab000000-0000-4000-8000-000000000099','synthetic-server@example.invalid');
    delete from public.family_model_dirty where family_id=fixture.id('family');
    set local role service_role;
    insert into public.family_members(family_id,user_id,display_name,role)
      values(fixture.id('family'),'ab000000-0000-4000-8000-000000000099','Synthetic server owner','parent')
      on conflict(family_id,user_id) do update set display_name=excluded.display_name,is_active=true;
    insert into public.family_members(family_id,user_id,display_name,role)
      values(fixture.id('family'),'ab000000-0000-4000-8000-000000000099','Synthetic reconciled owner','parent')
      on conflict(family_id,user_id) do update set display_name=excluded.display_name,is_active=true;
    reset role;
    perform fixture.assert_true((select count(*)=1 from public.family_members where user_id='ab000000-0000-4000-8000-000000000099'
      and display_name='Synthetic reconciled owner'),'server onboarding can insert and reconcile a linked membership');
    perform fixture.assert_true((select count(*)=1 from public.family_model_dirty where family_id=fixture.id('family')),
      'server membership upsert retains its required dirty mark');
    set constraints trg_family_keeps_a_manager immediate;
    raise exception 'Restore server onboarding control' using errcode='ZX004';
  exception when sqlstate 'ZX004' then null;
  end;
end $$;

do $$ declare affected integer; begin
  begin
    insert into public.assistant_links(family_id,user_id,label,token_hash,token_prefix)
      values(fixture.id('family'),fixture.id('parent'),'Synthetic lifecycle key','synthetic-lifecycle-hash','synthetic');
    delete from public.family_model_dirty where family_id=fixture.id('family');
    perform set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
    set local role authenticated;
    update public.family_members set is_active=false where id=fixture.id('parent-member');
    get diagnostics affected=row_count;
    perform fixture.assert_true(affected=1,'authenticated manager actually deactivates a member');
    reset role;
    perform fixture.assert_true((select count(*)=1 from public.family_model_dirty where family_id=fixture.id('family')),
      'deactivation inserts its missing dirty marker');
    perform fixture.assert_true((select count(*)=1 from public.assistant_links where token_hash='synthetic-lifecycle-hash' and revoked_at is not null),
      'deactivation retires the departed parent assistant key');
    set constraints trg_family_keeps_a_manager immediate;
    raise exception 'Restore lifecycle control' using errcode='ZX002';
  exception when sqlstate 'ZX002' then null;
  end;
end $$;

-- Account/FK maintenance uses main's CASCADE membership edge and keeps a
-- surviving manager; it must not acquire a global family lock or lose a mark.
do $$ begin
  begin
    perform set_config('request.jwt.claim.sub','',true);
    delete from public.family_model_dirty where family_id=fixture.id('family');
    delete from auth.users where id=fixture.id('parent');
    perform fixture.assert_true((select count(*)=0 from public.family_members where id=fixture.id('parent-member')),
      'auth-account cleanup cascades the membership');
    perform fixture.assert_true((select count(*)=1 from public.family_model_dirty where family_id=fixture.id('family')),
      'auth-account membership cascade creates its required dirty marker');
    set constraints trg_family_keeps_a_manager immediate;
    raise exception 'Restore auth maintenance control' using errcode='ZX003';
  exception when sqlstate 'ZX003' then null;
  end;
end $$;

-- Exercise actual authenticated parent cleanup, including the old message
-- with a mismatched family stamp. Roll back only this deletion afterward so
-- keep_fixture still supplies the primary family for two-session race probes.
do $$ declare affected integer; begin
  begin
    perform set_config('request.jwt.claim.sub', fixture.id('parent')::text, true);
    set local role authenticated;
    delete from public.families where id = fixture.id('family');
    get diagnostics affected = row_count;
    perform fixture.assert_true(affected = 1, 'active parent can actually delete their family under RLS');
    reset role;
    perform fixture.assert_true((select count(*) = 0 from public.family_conversations
      where family_id = fixture.id('family')), 'authenticated family deletion cleans all dependent conversations');
    perform fixture.assert_true((select count(*) = 0 from public.family_messages where family_id = fixture.id('family')),
      'authenticated family deletion cleans its dependent messages');
    perform fixture.assert_true((select count(*) = 0 from public.family_messages where id = fixture.id('poisoned-family-message')),
      'authenticated family cascade cleans a message whose old family stamp mismatches its deleted conversation');
    perform fixture.assert_true((select count(*) = 1 from public.families where id = fixture.id('other-family'))
      and (select count(*) = 1 from public.family_messages where id = fixture.id('foreign-message')),
      'authenticated family cascade preserves the other family and its own history');
    raise exception 'Restore synthetic family after successful deletion proof' using errcode = 'ZX001';
  exception when sqlstate 'ZX001' then null;
  end;
  perform fixture.assert_true((select count(*) = 1 from public.families where id = fixture.id('family')),
    'local deletion-proof rollback preserves the follow-on race fixture');
end $$;

-- Service/FK maintenance remains available. SET ROLE authenticated from this
-- superuser connection in earlier blocks must never inherit this exemption.
select set_config('request.jwt.claim.sub', '', true);
insert into public.families(id, name, created_by)
  values(fixture.id('cleanup-family'), 'Synthetic maintenance family', fixture.id('alice'));
insert into public.family_members(id, family_id, user_id, display_name, role)
  values(fixture.id('cleanup-member'), fixture.id('cleanup-family'), fixture.id('alice'), 'Cleanup parent', 'parent');
insert into public.family_conversations(id, family_id, name, created_by)
  values(fixture.id('cleanup-conversation'), fixture.id('cleanup-family'), 'Synthetic maintenance chat', fixture.id('alice'));
insert into public.family_messages(id, conversation_id, family_id, sender_id, content)
  values(fixture.id('cleanup-message'), fixture.id('cleanup-conversation'), fixture.id('cleanup-family'), fixture.id('alice'), 'Synthetic maintenance history');
delete from public.families where id = fixture.id('cleanup-family');
select fixture.assert_true((select count(*) = 0 from public.family_conversations where id = fixture.id('cleanup-conversation')),
  'maintenance FK cascade cleans conversations');
select fixture.assert_true((select count(*) = 0 from public.family_messages where id = fixture.id('cleanup-message')),
  'maintenance FK cascade cleans messages');
select fixture.assert_true((select count(*) = 2 from public.families), 'cleanup does not reach other synthetic families');
-- Composed durable operation identity must coexist with explicit actor admission.
do $$ declare sent public.family_messages; retry public.family_messages; begin
  perform set_config('request.jwt.claim.sub', fixture.id('alice')::text, true);
  set local role authenticated;
  sent := public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'), fixture.id('alice'),
    'Synthetic durable operation', 'text', null, 'synthetic-durable-operation');
  select * into retry from public.find_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'), fixture.id('alice'),
    'Changed retry text', 'text', null, now(), 'synthetic-durable-operation');
  perform fixture.assert_true(retry.id = sent.id and retry.content='Synthetic durable operation',
    'actor-authorized durable retry finds its original row despite changed text/window');
  begin
    perform public.send_family_message(fixture.id('family'), fixture.id('mixed'), fixture.id('alice-member'), fixture.id('alice'),
      'Second write under the same key', 'text', null, 'synthetic-durable-operation');
    raise exception 'Duplicate durable operation wrote a second row';
  exception when unique_violation then null; end;
  perform fixture.assert_true((select count(*)=1 from public.family_messages where idempotency_key='synthetic-durable-operation'),
    'durable operation writes once');
  begin
    update public.family_messages set idempotency_key='rewritten-operation' where id=sent.id;
    raise exception 'Immutable operation key changed';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Direct-chat reuse must match the union of both historical rosters.
do $$ declare existing_id uuid := 'af000000-0000-4000-8000-000000000001'; created public.family_conversations; begin
  insert into public.family_conversations(id,family_id,name,kind,created_by,participant_ids,member_ids)
    values(existing_id,fixture.id('family'),'Historical wider direct chat','direct',fixture.id('alice'),
      array[fixture.id('alice-member'),fixture.id('bob-member')],array[fixture.id('eve')]);
  perform set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
  set local role authenticated;
  created := public.create_family_conversation(fixture.id('family'),
    array[fixture.id('alice-member'),fixture.id('bob-member')],'New private direct chat','direct');
  perform fixture.assert_true(created.id <> existing_id,
    'A+B request never reuses historical A+B+C recorded audience');
  perform fixture.assert_true(cardinality(created.member_ids)=0 and cardinality(created.participant_ids)=2,
    'new direct chat contains exactly the requested audience');
  reset role;
  perform set_config('request.jwt.claim.sub','',true);
  delete from public.family_conversations where id in (existing_id,created.id);
end $$;

select 'messaging preserve access: real-role participant, history, reply, sender, receipt and cascade assertions PASS' as result;
-- Opt in only for follow-on two-session tests in the same disposable DB.
\if :keep_fixture
commit;
\else
rollback;
\endif
