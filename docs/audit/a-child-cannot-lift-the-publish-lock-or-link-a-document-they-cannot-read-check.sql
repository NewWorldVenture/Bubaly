-- ── AUTHZ-011 A child cannot lift the publish lock, or link a document they
--    cannot read ──────────────────────────────────────────────────────────────
--
-- Two guards from `0387_a_child_cannot_lift_the_publish_lock_or_link_a_document_they_cannot_read.sql`, proven
-- behaviourally, each with its NEGATIVE CONTROL FIRST.
--
-- 1. public.social_settings. The app writes it only after
--    requireSocialPermission(fid, 'manage_settings'); 0034 left INSERT, UPDATE
--    and DELETE on bare is_family_member(family_id). `require_approval` on this
--    row is the family's stop on publishing (needsPublishApproval), and a
--    missing row reads as "no approval". 0387 adds three RESTRICTIVE policies
--    on social_has_permission(family_id, 'manage_settings').
--
--    CONTROL: the SAME teen, the SAME row, the SAME statements. First the teen
--    holds an explicit marketing_manager override (a parent granted it), and
--    the update, the app's exact upsert, a fresh insert and a delete must all
--    LAND. Then the override is removed — the teen is back to their household
--    default, content_creator — and the very same statements must be refused.
--    Exactly one thing changes between the two halves: the answer
--    social_has_permission gives for this actor. The household role never
--    changes, so the control also proves the guard is NOT can_manage_family
--    (a teen fails that in both halves) — a guard on the wrong predicate would
--    refuse the control and turn this probe red as UNPROVEN.
--
--    What the control rules out: a revoked table GRANT, a column-level denial
--    on require_approval or updated_by (the control's SET list names both), a
--    dead auth.uid(), a guard trigger, and a row the session simply cannot see
--    — every one of those refuses the control too.
--
--    Then the other actors the lead names: the child (read_only by default), an
--    adult a parent pinned to read_only (0319's case), and a teen pinned to
--    social_manager — who holds publish_posts but NOT manage_settings, the one
--    for whom lifting the lock means posting unreviewed. Positive controls: the
--    parent (admin) and an adult on their default (marketing_manager). And the
--    read stays open, deliberately: needsPublishApproval reads require_approval
--    through the PUBLISHING member's own client.
--
-- 2. public.vacation_documents.document_id. The Trip -> Documents form is open
--    to every member for its eight form columns and never writes document_id;
--    the only writer of document_id is linkToVacation, which refuses a foreign
--    family's document and a sensitive one for a non-manager. 0387 adds a
--    SECURITY INVOKER BEFORE trigger that asks, as the caller, whether the
--    document is visible (documents_select) and in the row's family.
--
--    CONTROL: the SAME child, first doing what the product lets them do and the
--    guard must not break — edit the notes on a row a PARENT linked to a vault
--    document without touching document_id; re-save that row sending the
--    unchanged document_id back (the trigger fires on the column, so this is
--    what proves it compares values); link a NON-sensitive document of their
--    own family; repoint their own row at it. All must LAND. Then the same
--    child, the same statements, pointed at a vault document, at a document
--    that is sensitive by CATEGORY only, and at a document of another family
--    they belong to and CAN see (so that refusal is the same-family clause and
--    not invisibility), and moving a linked row into that other family: all
--    refused. Positive: the parent links and repoints to vault documents; the
--    trusted server (service_role) links one, and is still held to one family.
--
-- 3. The other direction. documents_update lets a member of two households
--    move a non-sensitive document between them, which would leave a trip row
--    pointing across households. 0387 adds a SECURITY DEFINER BEFORE UPDATE OF
--    family_id trigger on documents that refuses the move while a trip in
--    another household links the document.
--
--    CONTROL: the SAME child, the SAME statement shape, on an ordinary document
--    of their family that NO trip links: the move to the other household must
--    LAND, so documents RLS admits this child and a refusal below is the link
--    guard. A rename of a linked document must land too (the guard fires only
--    when the household changes). Then the same child moves a LINKED ordinary
--    document: refused. Unlinking it first, then moving it: lands. The trusted
--    server (service_role) moving a linked document: refused as well.
--
-- Everything runs in ONE transaction that is rolled back. Failures are
-- collected across all three guards and raised once at the end, so a red run names
-- every broken boundary rather than only the first.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-child-cannot-lift-the-publish-lock-or-link-a-document-they-cannot-read-check.sql

\set FA '00000000-0000-4000-8000-000000387a00'
\set UP '00000000-0000-4000-8000-000000387a01'
\set UK '00000000-0000-4000-8000-000000387a02'
\set UT '00000000-0000-4000-8000-000000387a03'
\set UA '00000000-0000-4000-8000-000000387a04'
\set US '00000000-0000-4000-8000-000000387a05'
\set UD '00000000-0000-4000-8000-000000387a06'
\set FX '00000000-0000-4000-8000-000000387b00'
\set UX '00000000-0000-4000-8000-000000387b01'

begin;

create temp table authz011_failures (msg text) on commit drop;

-- ── Households ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  (:'UP','authz011-parent@example.com'), (:'UK','authz011-child@example.com'),
  (:'UT','authz011-teen@example.com'),   (:'UA','authz011-adult-pinned@example.com'),
  (:'US','authz011-teen-social-manager@example.com'), (:'UD','authz011-adult@example.com'),
  (:'UX','authz011-other-parent@example.com')
  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FA','Publish Lock House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FX','The Other House',:'UX') on conflict do nothing;

-- handle_new_family files each creator as 'parent'; the roles below are
-- upserted rather than assumed, because a seed whose roles are wrong proves
-- nothing.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8000-000000387a31',:'FA',:'UP','Parent','parent',true),
  ('00000000-0000-4000-8000-000000387a32',:'FA',:'UK','Child','child',true),
  ('00000000-0000-4000-8000-000000387a33',:'FA',:'UT','Teen','teen',true),
  ('00000000-0000-4000-8000-000000387a34',:'FA',:'UA','Pinned adult','adult',true),
  ('00000000-0000-4000-8000-000000387a35',:'FA',:'US','Social-manager teen','teen',true),
  ('00000000-0000-4000-8000-000000387a36',:'FA',:'UD','Adult','adult',true),
  -- The same child is also a member of the other household, so that household's
  -- ordinary documents are VISIBLE to them — the cross-family refusal below is
  -- then the same-family clause talking, not invisibility.
  ('00000000-0000-4000-8000-000000387b32',:'FX',:'UK','Child (visiting)','child',true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;

-- Social-role overrides a parent set: the adult pinned to read_only, and the
-- teen given publish rights (social_manager) but not settings.
insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by) values
  (:'FA',:'UA','read_only','active',:'UP'),
  (:'FA',:'US','social_manager','active',:'UP')
  on conflict (family_id, user_id) do update set social_role = excluded.social_role, status = 'active';

-- The lock is ON.
insert into public.social_settings (family_id, require_approval, signature, created_by, updated_by)
  values (:'FA', true, '-- The Publish Lock House', :'UP', :'UP')
  on conflict (family_id) do update set require_approval = true, signature = excluded.signature;

-- A trip and four documents.
insert into public.vacations (id, family_id, title, created_by)
  values ('00000000-0000-4000-8000-000000387a10',:'FA','Lisbon',:'UP') on conflict do nothing;
insert into public.documents (id, family_id, title, category, storage_path, is_secure, created_by) values
  -- ordinary: every member may see and link it
  ('00000000-0000-4000-8000-000000387a11',:'FA','Hotel itinerary','Itinerary',
     '00000000-0000-4000-8000-000000387a00/itinerary.pdf', false, :'UP'),
  -- in the Secure Vault
  ('00000000-0000-4000-8000-000000387a12',:'FA','Vault deed','general',
     '00000000-0000-4000-8000-000000387a00/deed.pdf', true, :'UP'),
  -- sensitive by CATEGORY alone (is_secure false), the case 0312 widened
  ('00000000-0000-4000-8000-000000387a13',:'FA','Parent passport','Passports & IDs',
     '00000000-0000-4000-8000-000000387a00/passport.pdf', false, :'UP'),
  -- an ordinary document of the OTHER household
  ('00000000-0000-4000-8000-000000387b11',:'FX','Other house itinerary','Itinerary',
     '00000000-0000-4000-8000-000000387b00/itinerary.pdf', false, :'UX')
  on conflict do nothing;

-- The row a PARENT linked to the vault document, through linkToVacation.
insert into public.vacation_documents (id, family_id, vacation_id, document_id, kind, title, notes, created_by)
  values ('00000000-0000-4000-8000-000000387a20',:'FA','00000000-0000-4000-8000-000000387a10',
          '00000000-0000-4000-8000-000000387a12','other','Vault deed','', :'UP');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. social_settings
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  fam   constant uuid := '00000000-0000-4000-8000-000000387a00';
  up    constant uuid := '00000000-0000-4000-8000-000000387a01';
  uk    constant uuid := '00000000-0000-4000-8000-000000387a02';
  ut    constant uuid := '00000000-0000-4000-8000-000000387a03';
  ua    constant uuid := '00000000-0000-4000-8000-000000387a04';
  us    constant uuid := '00000000-0000-4000-8000-000000387a05';
  ud    constant uuid := '00000000-0000-4000-8000-000000387a06';
  n int;
  ok boolean;
  still_locked boolean;
  failures text[] := '{}';
  control_ok boolean := true;
  actor record;
begin
  -- Fixture: the teen's social role, with and without the override, is what
  -- the control needs it to be. Asked as the teen, because the helper reads
  -- auth.uid().
  perform set_config('role','postgres', true);
  insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by)
    values (fam, ut, 'marketing_manager', 'active', up)
    on conflict (family_id, user_id) do update set social_role = 'marketing_manager', status = 'active';

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', ut::text, true);
  if not public.social_has_permission(fam, 'manage_settings') or public.can_manage_family(fam) then
    control_ok := false;
    failures := array_append(failures, 'social_settings UNPROVEN: fixture — the teen with a marketing_manager override should hold manage_settings and NOT be a household manager');
  end if;

  -- ── NEGATIVE CONTROL: the same teen, holding manage_settings ─────────────
  -- (a) the lock-lifting UPDATE, naming require_approval AND updated_by
  if control_ok then
    begin
      update public.social_settings set require_approval = false, updated_by = ut where family_id = fam;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('social_settings UNPROVEN: the teen WITH manage_settings updated %s row(s), not 1 — a refusal below would prove nothing about the guard', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('social_settings UNPROVEN: the teen WITH manage_settings was refused the update (%s: %s)', sqlstate, sqlerrm));
    end;
  end if;

  -- (b) updateSettingsAction's exact shape: INSERT ... ON CONFLICT (family_id) DO UPDATE ... RETURNING
  if control_ok then
    begin
      insert into public.social_settings (family_id, default_timezone, require_approval, auto_hashtags, signature, ai_tone, default_platforms, updated_by)
        values (fam, 'UTC', false, true, 'teen was here', 'friendly', '{}', ut)
        on conflict (family_id) do update set require_approval = excluded.require_approval,
          signature = excluded.signature, updated_by = excluded.updated_by
        returning 1 into n;
      if n is distinct from 1 then
        control_ok := false;
        failures := array_append(failures, 'social_settings UNPROVEN: the app''s upsert returned no row for the teen WITH manage_settings');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('social_settings UNPROVEN: the app''s upsert was refused for the teen WITH manage_settings (%s: %s)', sqlstate, sqlerrm));
    end;
  end if;

  -- (c) DELETE, then (d) a fresh INSERT into the now-empty slot
  if control_ok then
    begin
      delete from public.social_settings where family_id = fam;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('social_settings UNPROVEN: the teen WITH manage_settings deleted %s row(s), not 1', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('social_settings UNPROVEN: the teen WITH manage_settings was refused the delete (%s: %s)', sqlstate, sqlerrm));
    end;
  end if;
  if control_ok then
    begin
      insert into public.social_settings (family_id, require_approval, signature, updated_by)
        values (fam, false, 'teen-owned settings', ut);
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('social_settings UNPROVEN: the teen WITH manage_settings was refused an insert (%s: %s)', sqlstate, sqlerrm));
    end;
  end if;

  -- Restore the lock, and take the override away: from here the teen is on
  -- their household default, content_creator. Nothing else changes.
  perform set_config('role','postgres', true);
  insert into public.social_settings (family_id, require_approval, signature, created_by, updated_by)
    values (fam, true, '-- The Publish Lock House', up, up)
    on conflict (family_id) do update set require_approval = true, signature = excluded.signature, updated_by = up;
  delete from public.social_access_permissions where family_id = fam and user_id = ut;

  if not control_ok then
    insert into authz011_failures select unnest(failures);
    return;
  end if;

  -- ── The same teen, the same statements, WITHOUT manage_settings ──────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', ut::text, true);
  if public.social_has_permission(fam, 'manage_settings') then
    failures := array_append(failures, 'social_settings fixture: the teen still holds manage_settings after the override was removed');
  end if;

  begin
    update public.social_settings set require_approval = false, updated_by = ut where family_id = fam;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a teen WITHOUT manage_settings LIFTED the publish lock (%s row)', n)); end if;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.social_settings (family_id, default_timezone, require_approval, auto_hashtags, signature, ai_tone, default_platforms, updated_by)
      values (fam, 'UTC', false, true, 'teen was here', 'friendly', '{}', ut)
      on conflict (family_id) do update set require_approval = excluded.require_approval,
        signature = excluded.signature, updated_by = excluded.updated_by;
    failures := array_append(failures, 'a teen WITHOUT manage_settings saved settings through the app''s own upsert');
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.social_settings where family_id = fam;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a teen WITHOUT manage_settings DELETED the settings row (%s), which needsPublishApproval reads as "no approval"', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- Planting a row where none exists: the empty slot is made as postgres, the
  -- insert is the teen's, and the slot is refilled whatever happens.
  perform set_config('role','postgres', true);
  delete from public.social_settings where family_id = fam;
  perform set_config('role','authenticated', true);
  begin
    insert into public.social_settings (family_id, require_approval, signature, updated_by)
      values (fam, false, 'teen-owned settings', ut);
    failures := array_append(failures, 'a teen WITHOUT manage_settings INSERTED the family''s settings row');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a teen''s settings INSERT reached the unique index, so RLS did not refuse it');
  end;
  perform set_config('role','postgres', true);
  insert into public.social_settings (family_id, require_approval, signature, created_by, updated_by)
    values (fam, true, '-- The Publish Lock House', up, up)
    on conflict (family_id) do update set require_approval = true, updated_by = up;

  -- ── The other members who do not hold manage_settings ───────────────────
  for actor in
    select * from (values
      (uk, 'the child (read_only)'),
      (ua, 'an adult pinned to read_only'),
      (us, 'a teen pinned to social_manager (publish_posts, not manage_settings)')
    ) as a(uid, label)
  loop
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', actor.uid::text, true);
    -- The read stays open, and is asked FIRST so a breach below cannot be what
    -- empties it: needsPublishApproval runs on the publisher's own client.
    select count(*) into n from public.social_settings where family_id = fam and require_approval;
    if n <> 1 then
      failures := array_append(failures, format('%s can no longer READ the publish lock — needsPublishApproval reads it on the publisher''s own client', actor.label));
    end if;
    begin
      update public.social_settings set require_approval = false, updated_by = up where family_id = fam;
      get diagnostics n = row_count;
      if n <> 0 then failures := array_append(failures, format('%s LIFTED the publish lock (and wrote the parent as updated_by)', actor.label)); end if;
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.social_settings where family_id = fam;
      get diagnostics n = row_count;
      if n <> 0 then failures := array_append(failures, format('%s DELETED the settings row', actor.label)); end if;
    exception when insufficient_privilege then null;
    end;
    perform set_config('role','postgres', true);
    insert into public.social_settings (family_id, require_approval, signature, created_by, updated_by)
      values (fam, true, '-- The Publish Lock House', up, up)
      on conflict (family_id) do update set require_approval = true, updated_by = up;
  end loop;

  -- ── Positive: the parent (admin) and an adult on their default ──────────
  for actor in
    select * from (values (up, 'the parent (admin)'), (ud, 'an adult (marketing_manager by default)')) as a(uid, label)
  loop
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', actor.uid::text, true);
    begin
      insert into public.social_settings (family_id, default_timezone, require_approval, auto_hashtags, signature, ai_tone, default_platforms, updated_by)
        values (fam, 'Europe/Lisbon', true, true, 'saved by a manager', 'friendly', '{}', actor.uid)
        on conflict (family_id) do update set require_approval = excluded.require_approval,
          default_timezone = excluded.default_timezone, updated_by = excluded.updated_by;
    exception when others then
      failures := array_append(failures, format('%s could not save settings (%s: %s) — the guard refuses a legitimate writer', actor.label, sqlstate, sqlerrm));
    end;
  end loop;

  perform set_config('role','postgres', true);
  select require_approval into still_locked from public.social_settings where family_id = fam;
  if still_locked is distinct from true then
    failures := array_append(failures, 'the publish lock ended the run OFF');
  end if;

  insert into authz011_failures select unnest(failures);
  if array_length(failures, 1) is null then
    raise notice 'AUTHZ-011 OK social_settings: the same teen CAN update, upsert, delete and insert the settings while holding manage_settings (control), and cannot once it is taken away; the child, an adult pinned to read_only and a social_manager teen cannot lift or delete the lock; parent and adult still save; every member still reads it';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. vacation_documents.document_id
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  fam      constant uuid := '00000000-0000-4000-8000-000000387a00';
  other    constant uuid := '00000000-0000-4000-8000-000000387b00';
  up       constant uuid := '00000000-0000-4000-8000-000000387a01';
  uk       constant uuid := '00000000-0000-4000-8000-000000387a02';
  trip     constant uuid := '00000000-0000-4000-8000-000000387a10';
  d_plain  constant uuid := '00000000-0000-4000-8000-000000387a11';
  d_vault  constant uuid := '00000000-0000-4000-8000-000000387a12';
  d_pass   constant uuid := '00000000-0000-4000-8000-000000387a13';
  d_other  constant uuid := '00000000-0000-4000-8000-000000387b11';
  r_linked constant uuid := '00000000-0000-4000-8000-000000387a20';
  r_mine   constant uuid := '00000000-0000-4000-8000-000000387a21';
  r_try    constant uuid := '00000000-0000-4000-8000-000000387a22';
  r_parent constant uuid := '00000000-0000-4000-8000-000000387a23';
  r_server constant uuid := '00000000-0000-4000-8000-000000387a24';
  n int;
  failures text[] := '{}';
  control_ok boolean := true;
  target record;
begin
  -- Fixture: the sensitivity the refusals rest on is the database's own.
  perform set_config('role','postgres', true);
  select count(*) into n from public.documents
   where id in (d_vault, d_pass) and public.is_sensitive_document(is_secure, category);
  if n <> 2 then
    control_ok := false;
    failures := array_append(failures, format('vacation_documents UNPROVEN: fixture — %s of the 2 sensitive documents classify as sensitive', n));
  end if;
  select count(*) into n from public.documents
   where id in (d_plain, d_other) and not public.is_sensitive_document(is_secure, category);
  if n <> 2 then
    control_ok := false;
    failures := array_append(failures, format('vacation_documents UNPROVEN: fixture — %s of the 2 ordinary documents classify as ordinary', n));
  end if;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', uk::text, true);

  -- What the child can SEE: the two ordinary documents, including the other
  -- household's, and neither sensitive one.
  select count(*) into n from public.documents where id in (d_plain, d_other);
  if n <> 2 then
    control_ok := false;
    failures := array_append(failures, format('vacation_documents UNPROVEN: fixture — the child sees %s of the 2 ordinary documents (the cross-family refusal would then be invisibility, not the family clause)', n));
  end if;
  select count(*) into n from public.documents where id in (d_vault, d_pass);
  if n <> 0 then
    failures := array_append(failures, format('the child can READ %s sensitive document(s) — documents_select no longer hides them (a separate boundary, 0266/0312)', n));
  end if;

  -- ── NEGATIVE CONTROL: the same child, doing what the product allows ───────
  -- (a) edit the notes on the row a parent linked to the vault document
  if control_ok then
    begin
      update public.vacation_documents set notes = 'bring a copy' where id = r_linked;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('vacation_documents UNPROVEN: the child''s notes edit on a parent-linked row changed %s row(s), not 1', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('vacation_documents UNPROVEN: the child was refused a notes edit on a parent-linked row (%s: %s) — the guard breaks the Trip -> Documents tab', sqlstate, sqlerrm));
    end;
  end if;
  -- (b) re-save that row sending the UNCHANGED document_id back: the trigger
  --     fires on the column, so only the value comparison lets this through
  if control_ok then
    begin
      update public.vacation_documents set notes = 'bring two copies', document_id = d_vault where id = r_linked;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('vacation_documents UNPROVEN: re-sending an unchanged document_id changed %s row(s), not 1', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('vacation_documents UNPROVEN: the child was refused re-saving a parent-linked row with its document_id unchanged (%s: %s)', sqlstate, sqlerrm));
    end;
  end if;
  -- (c) link an ORDINARY document of their own family — the same INSERT shape
  --     as the refusals below
  if control_ok then
    begin
      insert into public.vacation_documents (id, family_id, vacation_id, document_id, kind, title, created_by)
        values (r_mine, fam, trip, d_plain, 'itinerary', 'Hotel itinerary', uk);
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('vacation_documents UNPROVEN: the child was refused linking an ORDINARY document of their own family (%s: %s) — a refusal below would prove nothing', sqlstate, sqlerrm));
    end;
  end if;
  -- (d) repoint their own row at it — the same UPDATE shape as the refusals
  if control_ok then
    begin
      update public.vacation_documents set document_id = null where id = r_mine;
      update public.vacation_documents set document_id = d_plain where id = r_mine;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('vacation_documents UNPROVEN: repointing the child''s own row at an ordinary document changed %s row(s), not 1', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('vacation_documents UNPROVEN: the child was refused repointing their own row at an ordinary document (%s: %s)', sqlstate, sqlerrm));
    end;
  end if;

  if not control_ok then
    perform set_config('role','postgres', true);
    insert into authz011_failures select unnest(failures);
    return;
  end if;

  -- ── The same child, the same statements, at documents they may not link ──
  for target in
    select * from (values
      (d_vault, fam,   'a Secure Vault document'),
      (d_pass,  fam,   'a document sensitive by category alone (Passports & IDs)'),
      (d_other, fam,   'another household''s document they CAN see')
    ) as t(doc, row_family, label)
  loop
    begin
      insert into public.vacation_documents (id, family_id, vacation_id, document_id, kind, title, created_by)
        values (r_try, target.row_family, trip, target.doc, 'other', 'planted', uk);
      failures := array_append(failures, format('a child LINKED %s to a trip', target.label));
      perform set_config('role','postgres', true);
      delete from public.vacation_documents where id = r_try;
      perform set_config('role','authenticated', true);
    exception when insufficient_privilege then null;
    end;
    begin
      update public.vacation_documents set document_id = target.doc where id = r_mine;
      get diagnostics n = row_count;
      if n <> 0 then
        failures := array_append(failures, format('a child REPOINTED their own trip row at %s', target.label));
        perform set_config('role','postgres', true);
        update public.vacation_documents set document_id = d_plain where id = r_mine;
        perform set_config('role','authenticated', true);
      end if;
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- Moving a linked row into the other household: the document stays behind.
  begin
    update public.vacation_documents set family_id = other where id = r_mine;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, 'a child MOVED a linked row into another household, leaving its document_id pointing across families'); end if;
  exception when insufficient_privilege then null;
  end;

  -- ── Positive: the parent links and repoints to vault documents ───────────
  perform set_config('request.jwt.claim.sub', up::text, true);
  begin
    insert into public.vacation_documents (id, family_id, vacation_id, document_id, kind, title, created_by)
      values (r_parent, fam, trip, d_vault, 'other', 'Vault deed', up);
    update public.vacation_documents set document_id = d_pass where id = r_parent;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the PARENT could not repoint a link at a sensitive document — the guard refuses a manager'); end if;
  exception when others then
    failures := array_append(failures, format('the PARENT could not link a sensitive document (%s: %s) — the guard refuses a manager', sqlstate, sqlerrm));
  end;

  -- ── Trusted server: links a sensitive one; still one household ──────────
  perform set_config('role','service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role','service_role', true);
  begin
    insert into public.vacation_documents (id, family_id, vacation_id, document_id, kind, title)
      values (r_server, fam, trip, d_pass, 'passport', 'Parent passport');
  exception when others then
    failures := array_append(failures, format('service_role could not link a same-family sensitive document (%s: %s) — linkToVacation on the run executor would break', sqlstate, sqlerrm));
  end;
  begin
    update public.vacation_documents set document_id = d_other where id = r_server;
    failures := array_append(failures, 'service_role linked a trip row to another household''s document');
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- Nothing the child tried is left behind, and the parent's link is intact.
  select count(*) into n from public.vacation_documents
   where family_id = fam and document_id in (d_vault, d_pass, d_other) and created_by = uk;
  if n <> 0 then failures := array_append(failures, format('%s child-created row(s) point at a document the child may not link', n)); end if;
  select count(*) into n from public.vacation_documents where id = r_linked and document_id = d_vault;
  if n <> 1 then failures := array_append(failures, 'the parent-linked row lost its document_id'); end if;

  insert into authz011_failures select unnest(failures);
  if array_length(failures, 1) is null then
    raise notice 'AUTHZ-011 OK vacation_documents: the same child CAN edit notes on a parent-linked row, re-send its unchanged document_id and link or repoint to an ordinary family document (control), and cannot link or repoint to a vault document, a category-sensitive one, or another household''s visible one, nor move a linked row across households; the parent and the trusted server still link sensitive documents, and even the server stays in one household';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. documents.family_id — a document a trip links does not leave the household
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  fam      constant uuid := '00000000-0000-4000-8000-000000387a00';
  other    constant uuid := '00000000-0000-4000-8000-000000387b00';
  up       constant uuid := '00000000-0000-4000-8000-000000387a01';
  uk       constant uuid := '00000000-0000-4000-8000-000000387a02';
  trip     constant uuid := '00000000-0000-4000-8000-000000387a10';
  d_free   constant uuid := '00000000-0000-4000-8000-000000387a14';
  d_move   constant uuid := '00000000-0000-4000-8000-000000387a15';
  d_server constant uuid := '00000000-0000-4000-8000-000000387a16';
  r_move   constant uuid := '00000000-0000-4000-8000-000000387a25';
  r_server constant uuid := '00000000-0000-4000-8000-000000387a26';
  n int;
  failures text[] := '{}';
  control_ok boolean := true;
begin
  -- Fixture, as the owner: three ordinary documents of the child's household;
  -- two of them linked from the household's trip.
  perform set_config('role','postgres', true);
  insert into public.documents (id, family_id, title, category, storage_path, is_secure, created_by) values
    (d_free,   fam, 'Unlinked itinerary', 'Itinerary', fam::text || '/free.pdf',   false, up),
    (d_move,   fam, 'Linked itinerary',   'Itinerary', fam::text || '/move.pdf',   false, up),
    (d_server, fam, 'Server itinerary',   'Itinerary', fam::text || '/server.pdf', false, up);
  insert into public.vacation_documents (id, family_id, vacation_id, document_id, kind, title, created_by) values
    (r_move,   fam, trip, d_move,   'itinerary', 'Linked itinerary', up),
    (r_server, fam, trip, d_server, 'itinerary', 'Server itinerary', up);

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', uk::text, true);

  -- ── NEGATIVE CONTROL: the same child may move an UNLINKED ordinary document ─
  begin
    update public.documents set family_id = other where id = d_free;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('documents UNPROVEN: the child moved %s unlinked document(s), not 1 — documents RLS refuses this child, so a refusal below would prove nothing about the link guard', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('documents UNPROVEN: the child was refused moving an UNLINKED ordinary document (%s: %s)', sqlstate, sqlerrm));
  end;
  -- …and may still edit a linked one without moving it
  begin
    update public.documents set title = 'Linked itinerary (v2)' where id = d_move;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('documents UNPROVEN: renaming a linked document changed %s row(s), not 1', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('documents UNPROVEN: the child was refused renaming a linked document (%s: %s) — the guard fires on more than a household change', sqlstate, sqlerrm));
  end;

  if not control_ok then
    perform set_config('role','postgres', true);
    insert into authz011_failures select unnest(failures);
    return;
  end if;

  -- ── The same child, the same statement, on a LINKED document ─────────────
  begin
    update public.documents set family_id = other where id = d_move;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a child MOVED a trip-linked document into another household, leaving the trip pointing across households');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- Unlink first, then move: the guard does not pin a document forever.
  begin
    update public.vacation_documents set document_id = null where id = r_move;
    update public.documents set family_id = other where id = d_move;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('after unlinking, the child''s move changed %s row(s), not 1', n)); end if;
  exception when others then
    failures := array_append(failures, format('the child could not move a document after unlinking it from the trip (%s: %s) — the guard outlives the link', sqlstate, sqlerrm));
  end;

  -- ── Trusted server: held to it as well ─────────────────────────────────
  perform set_config('role','service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role','service_role', true);
  begin
    update public.documents set family_id = other where id = d_server;
    failures := array_append(failures, 'service_role MOVED a trip-linked document into another household');
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- Nothing in either household is left pointing across the boundary.
  select count(*) into n
    from public.vacation_documents v
    join public.documents d on d.id = v.document_id
   where v.family_id in (fam, other)
     and d.family_id <> v.family_id;
  if n <> 0 then failures := array_append(failures, format('%s trip row(s) point at a document in another household', n)); end if;

  insert into authz011_failures select unnest(failures);
  if array_length(failures, 1) is null then
    raise notice 'AUTHZ-011 OK documents: the same child CAN move an unlinked ordinary document between their two households and rename a linked one (control), and cannot move a trip-linked one until it is unlinked; the trusted server cannot either; no trip row points across households';
  end if;
end $$;

-- ── One verdict for all three guards ───────────────────────────────────────
do $$
declare
  msgs text[];
begin
  select array_agg(msg) into msgs from authz011_failures;
  if msgs is not null then
    raise exception 'AUTHZ-011 boundary failed: %', array_to_string(msgs, ' | ');
  end if;
end $$;

rollback;
