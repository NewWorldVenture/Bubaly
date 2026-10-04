-- ── Voice history is the speaker's; linked-assistant logs are the managers' ──
--
-- #771 comment 5973585839, owner approval #927 comment 5975179712. Synthetic
-- data only, as real roles with real JWT claims, rolled back:
--
--   1. a CHILD reads their own voice commands;
--   2. the child reads none of a sibling's or a parent's commands;
--   3. a PARENT (manager) reads every member's commands;
--   4. a command with no member is read by the account that filed it, and not
--      by a sibling;
--   5. another family's parent reads none of them;
--   6. a PARENT reads the linked-assistant log;
--   7. a CHILD and a TEEN read none of it;
--   8. the household still works: the child files their own command and reads
--      it back; the service role still files a link event;
--   9. NEGATIVE CONTROL: with the old family-wide SELECT policies restored (in
--      a subtransaction), the child reads the sibling's command and the link
--      log — so checks 2 and 7 are what the migration changed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/voice-history-and-link-log-privacy-check.sql

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0101', 'vl-parent@example.com'),
  ('00000000-0000-4000-8000-0000000c0102', 'vl-child@example.com'),
  ('00000000-0000-4000-8000-0000000c0103', 'vl-teen@example.com'),
  ('00000000-0000-4000-8000-0000000c0104', 'vl-other-parent@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8000-0000000c01f0', 'Voice Probe House', '00000000-0000-4000-8000-0000000c0101'),
  ('00000000-0000-4000-8000-0000000c01f1', 'Voice Probe Other', '00000000-0000-4000-8000-0000000c0104');
-- A family's creator is enrolled as its parent when the family is created; the
-- two parents' member rows are that enrolment (made sure of here), the child
-- and teen are added.
insert into public.family_members (family_id, user_id, role, display_name, is_active) values
  ('00000000-0000-4000-8000-0000000c01f0', '00000000-0000-4000-8000-0000000c0101', 'parent', 'Parent', true),
  ('00000000-0000-4000-8000-0000000c01f1', '00000000-0000-4000-8000-0000000c0104', 'parent', 'Other',  true)
  on conflict (family_id, user_id) do nothing;
insert into public.family_members (id, family_id, user_id, role, display_name, is_active) values
  ('00000000-0000-4000-8000-0000000c01a2', '00000000-0000-4000-8000-0000000c01f0', '00000000-0000-4000-8000-0000000c0102', 'child',  'Child',  true),
  ('00000000-0000-4000-8000-0000000c01a3', '00000000-0000-4000-8000-0000000c01f0', '00000000-0000-4000-8000-0000000c0103', 'teen',   'Teen',   true);
insert into public.voice_commands (id, family_id, member_id, transcript, status, created_by) values
  ('00000000-0000-4000-8000-0000000c01c1', '00000000-0000-4000-8000-0000000c01f0', '00000000-0000-4000-8000-0000000c01a2', 'VL-PROBE child: add slime to the list', 'routed', '00000000-0000-4000-8000-0000000c0102'),
  ('00000000-0000-4000-8000-0000000c01c2', '00000000-0000-4000-8000-0000000c01f0', '00000000-0000-4000-8000-0000000c01a3', 'VL-PROBE teen: remind me about the counsellor', 'routed', '00000000-0000-4000-8000-0000000c0103'),
  ('00000000-0000-4000-8000-0000000c01c3', '00000000-0000-4000-8000-0000000c01f0',
   (select id from public.family_members where family_id = '00000000-0000-4000-8000-0000000c01f0' and user_id = '00000000-0000-4000-8000-0000000c0101'),
   'VL-PROBE parent: book the anniversary dinner', 'routed', '00000000-0000-4000-8000-0000000c0101'),
  ('00000000-0000-4000-8000-0000000c01c4', '00000000-0000-4000-8000-0000000c01f0', null, 'VL-PROBE teen without a member row', 'failed', '00000000-0000-4000-8000-0000000c0103');
insert into public.assistant_links (id, family_id, user_id, label, token_hash, token_prefix) values
  ('00000000-0000-4000-8000-0000000c01d1', '00000000-0000-4000-8000-0000000c01f0', '00000000-0000-4000-8000-0000000c0101', 'Kitchen speaker', 'vl-probe-hash', 'vlprobe');
insert into public.assistant_link_events (link_id, family_id, intent, utterance, outcome) values
  ('00000000-0000-4000-8000-0000000c01d1', '00000000-0000-4000-8000-0000000c01f0', 'capture', 'VL-PROBE what someone said to the speaker', 'captured');

do $$
declare
  fam       constant uuid := '00000000-0000-4000-8000-0000000c01f0';
  parent    constant text := '{"sub":"00000000-0000-4000-8000-0000000c0101","role":"authenticated"}';
  child     constant text := '{"sub":"00000000-0000-4000-8000-0000000c0102","role":"authenticated"}';
  teen      constant text := '{"sub":"00000000-0000-4000-8000-0000000c0103","role":"authenticated"}';
  outsider  constant text := '{"sub":"00000000-0000-4000-8000-0000000c0104","role":"authenticated"}';
  failures  text[] := '{}';
  n int;
  seen text[];
begin
  -- Lists are compared in byte order (collate "C"): the database's default
  -- collation differs between CI and a developer's machine.
  -- ── As the CHILD ──
  perform set_config('request.jwt.claims', child, true);
  perform set_config('role', 'authenticated', true);
  select array_agg(transcript order by transcript collate "C") into seen from public.voice_commands where family_id = fam;
  -- 1, 2
  if seen is distinct from array['VL-PROBE child: add slime to the list'] then
    failures := array_append(failures, format('the child should read exactly their own command; read %s', seen));
  end if;
  -- 7
  select count(*) into n from public.assistant_link_events where family_id = fam;
  if n <> 0 then failures := array_append(failures, format('the child read %s linked-assistant log rows', n)); end if;
  -- 8: the child still files and reads back their own command.
  insert into public.voice_commands (family_id, member_id, transcript, status, created_by)
    values (fam, '00000000-0000-4000-8000-0000000c01a2', 'VL-PROBE child second', 'routed', '00000000-0000-4000-8000-0000000c0102');
  select count(*) into n from public.voice_commands where family_id = fam and transcript = 'VL-PROBE child second';
  if n <> 1 then failures := array_append(failures, 'the child could not read back a command they just filed'); end if;

  -- ── As the TEEN ──
  perform set_config('request.jwt.claims', teen, true);
  select array_agg(transcript order by transcript collate "C") into seen from public.voice_commands where family_id = fam;
  -- 2, 4
  if seen is distinct from array['VL-PROBE teen without a member row', 'VL-PROBE teen: remind me about the counsellor'] then
    failures := array_append(failures, format('the teen should read their own two commands (one filed without a member row); read %s', seen));
  end if;
  -- 7
  select count(*) into n from public.assistant_link_events where family_id = fam;
  if n <> 0 then failures := array_append(failures, format('the teen read %s linked-assistant log rows', n)); end if;

  -- ── As the PARENT ──
  perform set_config('request.jwt.claims', parent, true);
  -- 3
  select count(*) into n from public.voice_commands where family_id = fam;
  if n <> 5 then failures := array_append(failures, format('a parent should read all 5 of the family''s commands; read %s', n)); end if;
  -- 6
  select count(*) into n from public.assistant_link_events where family_id = fam;
  if n <> 1 then failures := array_append(failures, format('a parent should read the linked-assistant log; read %s rows', n)); end if;

  -- ── As ANOTHER family's parent ── 5
  perform set_config('request.jwt.claims', outsider, true);
  select count(*) into n from public.voice_commands where family_id = fam;
  if n <> 0 then failures := array_append(failures, format('another family''s parent read %s voice commands', n)); end if;
  select count(*) into n from public.assistant_link_events where family_id = fam;
  if n <> 0 then failures := array_append(failures, format('another family''s parent read %s link log rows', n)); end if;

  perform set_config('role', 'none', true);

  -- 8: the service path still files a link event (the role the app uses).
  begin
    perform set_config('role', 'service_role', true);
    insert into public.assistant_link_events (link_id, family_id, intent, utterance, outcome)
      values ('00000000-0000-4000-8000-0000000c01d1', fam, 'ask', 'VL-PROBE service write', 'answered');
    perform set_config('role', 'none', true);
  exception when others then
    perform set_config('role', 'none', true);
    failures := array_append(failures, format('the service role could no longer file a link event: %s', sqlerrm));
  end;

  -- 9. NEGATIVE CONTROL: the old family-wide policies, and the child reads it all.
  begin
    drop policy voice_commands_select on public.voice_commands;
    create policy voice_commands_select on public.voice_commands for select using (public.is_family_member(family_id));
    drop policy assistant_link_events_select on public.assistant_link_events;
    create policy assistant_link_events_select on public.assistant_link_events for select using (public.is_family_member(family_id));
    perform set_config('request.jwt.claims', child, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from public.voice_commands where family_id = fam and transcript like 'VL-PROBE teen%';
    if n = 0 then
      failures := array_append(failures, 'negative control: under the old policy the child still could not read the teen''s command — check 2 does not show what the migration changed');
    end if;
    select count(*) into n from public.assistant_link_events where family_id = fam;
    if n = 0 then
      failures := array_append(failures, 'negative control: under the old policy the child still could not read the link log — check 7 does not show what the migration changed');
    end if;
    raise exception using errcode = 'P0001', message = 'probe-rollback';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'probe-rollback' then raise; end if;
  end;
  perform set_config('role', 'none', true);

  if array_length(failures, 1) > 0 then
    raise exception E'voice/link privacy probe failed:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'voice/link privacy probe: 9 assertion groups hold (speaker and manager read voice history, siblings and other families do not; only managers read the link log; own filing and the service write still work; negative control)';
end
$$;

rollback;
