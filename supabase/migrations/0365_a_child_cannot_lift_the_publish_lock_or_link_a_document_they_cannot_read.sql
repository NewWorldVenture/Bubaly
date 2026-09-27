-- Bubaly :: 0365 - a child cannot lift the publish lock, or link a document
--                  they cannot read (AUTHZ-011)
--
-- Two tables whose write rule lived in TypeScript and nowhere a client cannot
-- route around. Every signed-in member holds a JWT and a browser client on the
-- anon key (lib/supabase/client.ts), so /rest/v1 reaches both directly.
--
-- ── 1. public.social_settings ────────────────────────────────────────────────
--
-- The app's rule, stated in three places that agree:
--   * app/(app)/dashboard/social/actions.ts updateSettingsAction calls
--     `requireSocialPermission(fid, 'manage_settings')` two statements before
--     its one write, an upsert on `family_id` through the member's own JWT;
--   * app/(app)/dashboard/social/settings/page.tsx disables Save and shows
--     `yourRoleCantChangeSettings` unless `access.can('manage_settings')`;
--   * lib/social/roles.ts / access.ts: "The database RLS ... is the real
--     enforcement boundary; this mirrors it", "RLS is the backstop".
--
-- The database's rule: 0034's generic loop (`foreach t in array social_tables`)
-- gave this table `social_settings_{insert,update,delete}` on
-- `is_family_member(family_id)`, and no migration since has touched them. So a
-- child (read_only), a teen (content_creator), or an adult a parent pinned to
-- read_only — none of whom holds manage_settings — can PATCH, POST or DELETE the
-- family's row.
--
-- The row carries `require_approval`, which lib/social/scheduled-authority.ts
-- needsPublishApproval reads on every publish-now (lib/social/publish.ts) and
-- every scheduled publish; `true` refuses the publish. Nothing in app/ or lib/
-- writes social_posts.approval_status, whose default is 'not_required', so this
-- switch IS the family's stop on posting to its connected accounts. A missing
-- row reads as "no approval", so DELETE lifts it too. The sharpest case: a
-- parent gives a teen publish rights (social_manager: publish_posts, NOT
-- manage_settings) and turns the lock on; the teen turns it off over REST and
-- posts.
--
-- The guard is RESTRICTIVE, 0254's mechanism as used by 0319/0343: it ANDs with
-- the permissive union, so no permissive policy present or added later can grant
-- past it. The predicate is the app's own rule, not a household-role proxy:
--
--   social_has_permission(family_id, 'manage_settings')
--
-- resolves the caller's social role exactly as lib/social/access.ts does (an
-- active social_access_permissions override wins, else parent->admin,
-- adult->marketing_manager, teen->content_creator, else read_only), and admits
-- manage_settings for owner, admin and marketing_manager — the same set as
-- ROLE_PERMISSIONS in lib/social/roles.ts. Deliberately NOT:
--   * can_manage_family (parent/adult): refuses a teen a parent explicitly made
--     marketing_manager, whom the action admits (Save would 500), and admits an
--     adult pinned to read_only, whom the action refuses — the case 0319 exists
--     for;
--   * is_family_admin (parent only): refuses every adult, whose default
--     marketing_manager the action admits.
--
-- updateSettingsAction's upsert is INSERT ... ON CONFLICT (family_id) DO UPDATE,
-- which must pass the INSERT check AND the UPDATE using/check; all three are the
-- same predicate, so it passes for exactly the callers requireSocialPermission
-- already admitted. DELETE has no application writer at all. SELECT is left
-- alone on purpose: needsPublishApproval reads require_approval through the
-- PUBLISHING member's own client, and that member may be a social_manager who
-- lacks manage_settings; the content studio reads default_timezone for every
-- creator. Family deletion cascades run as the table owner and are unaffected.
--
-- `to authenticated, anon`: 0034's policies are TO public, and 0290's lesson is
-- that anon holds DML by default privileges. anon is already refused by
-- is_family_member (auth.uid() is null); naming it is belt and braces, as 0343.
--
-- ── 2. public.vacation_documents.document_id ─────────────────────────────────
--
-- NARROWER than a manager-only table, and the narrowing is the design. The Trip
-- -> Documents tab (components/vacations/trip-documents.tsx, through the generic
-- TripCrudSection in components/vacations/shared.tsx) lets every member add,
-- edit and delete travel documents with no role check, for its eight form
-- columns: title, kind, member_id, number, file_url, issued_on, expires_on,
-- notes. That is intended (a child adds their own boarding pass), stays open,
-- and is NOT touched here. That form never writes `document_id`: it is not in
-- the field list, and toRow emits only field names.
--
-- `document_id` points a trip at a row of the family's document store, and it
-- has exactly one writer: lib/services/documents/index.ts linkToVacation, which
-- looks the document up with `.eq('family_id', scope.familyId)` (a foreign
-- family's document is "not found") and refuses a sensitive one unless
-- canReadSensitive(scope) — "you cannot attach a file you are not allowed to
-- hold". The database accepts both refused links: 0070 gave the table one FOR
-- ALL policy on is_family_member(family_id), and the foreign-key check on
-- document_id runs as the table owner, ignoring documents RLS. Measured on a
-- replay: a child inserted a row whose document_id was a vault document they
-- could not see, repointed an existing row at one, and linked another family's
-- document.
--
-- What it buys today, stated so nobody reads more into it: nothing in app/,
-- lib/ or components/ follows vacation_documents.document_id to fetch or sign a
-- file, and readDocument re-checks family and sensitivity per caller. This
-- closes a latent integrity gap on one column — a pointer the app promises
-- only it writes — before something starts trusting it.
--
-- WHY A TRIGGER AND NOT A WITH CHECK. A WITH CHECK is re-evaluated on every
-- UPDATE against the whole new row, including a document_id the writer did not
-- change. A child fixing the notes on a row a parent linked to a passport would
-- then be refused over a column they never touched. The rule is about SETTING
-- the pointer, so the guard fires only on INSERT with a non-null document_id,
-- or on an UPDATE that actually changes document_id or family_id (family_id so
-- a linked row cannot be moved into a household the document does not belong
-- to). An UPDATE that re-sends the same document_id passes.
--
-- WHY SECURITY INVOKER, and why that is the drift-proof choice. The guard asks
-- one positive question as the CALLER:
--
--   exists (select 1 from public.documents d
--            where d.id = new.document_id and d.family_id = new.family_id)
--
-- Run as the caller, that read goes through `documents_select` (0266) itself —
-- is_family_member(family_id) and (not is_sensitive_document(is_secure,
-- category) or can_manage_family(family_id)) — so "may link" is literally "may
-- read" plus "same family", and the write rule cannot drift from the read rule
-- because it IS the read rule, not a second copy of its predicate. A child
-- cannot see a sensitive document, so it is not found and the link is refused;
-- a manager can, so it lands; a non-sensitive document of the family lands for
-- anyone. This is the opposite of 0303's trap, where an invoker lookup phrased
-- as NOT EXISTS turned invisibility into permission: here invisibility is the
-- refusal, so the guard fails closed. The trusted server (service_role, a
-- migration or seed) bypasses RLS, sees every row, and is still held to "same
-- family" — linkToVacation on the run executor's service client filters by
-- family already, so it is unaffected; the sensitivity rule on that path stays
-- canReadSensitive(scope.role), as before. A document deleted later sets the
-- pointer to NULL through its ON DELETE SET NULL action; NULL is never checked.
--
-- An upsert is checked as an INSERT. For INSERT ... ON CONFLICT DO UPDATE,
-- Postgres fires BEFORE INSERT on the proposed row before it knows the row will
-- conflict, so re-sending an unchanged pointer to a document the caller cannot
-- read through an upsert is refused, where the same edit as an UPDATE passes.
-- That is the fail-closed answer: at that moment the statement may still insert
-- a new link. No writer upserts this table (TripCrudSection uses .update and
-- .insert; linkToVacation uses .insert).
--
-- ── 3. The other direction: a linked document does not leave the household ──
--
-- Section 2 holds "same family" only when vacation_documents is written. The
-- same pair can drift apart from the documents side: documents_update (0266)
-- lets a member of two households UPDATE documents SET family_id = <the other
-- household> on a non-sensitive document, and the trip row is left pointing
-- across households. Nothing in app/, lib/ or components/ ever changes
-- documents.family_id (the only UPDATEs set is_secure and is_favorite).
--
-- trg_documents_linked_trip_stays_home fires BEFORE UPDATE OF family_id, only
-- WHEN the household actually changes, and refuses (42501) while any
-- vacation_documents row in another household still links the document;
-- unlinking it first, then moving it, still works. The function is SECURITY
-- DEFINER on purpose, the opposite choice from section 2 and for the reason
-- that section gives: the question is "does ANY trip row link this document",
-- an integrity fact, and asked as the caller it would become "does any trip row
-- I can see", so an invisible link would pass as permission. It reads one table,
-- by id, with a pinned search_path; EXECUTE is revoked from public, anon and
-- authenticated (a trigger function is never called directly and firing one
-- does not check EXECUTE, 0344:330 / 0355:144). It holds service_role too.
--
-- ── Pointers written before this migration ─────────────────────────────────
--
-- A pointer at ANOTHER household's document is invalid whoever wrote it, so
-- the migration clears it (document_id = NULL, the same state ON DELETE SET
-- NULL leaves) and raises a NOTICE with the count. A pointer at a SENSITIVE
-- document of the row's own household is left alone: a manager may have made
-- it through linkToVacation, and created_by is client-supplied, so there is no
-- honest way to tell a child's planted link from a parent's. Such a pointer
-- grants nothing today; readDocument re-checks family and sensitivity per
-- caller, and nothing follows vacation_documents.document_id.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
-- Idempotent: every policy, function and trigger is dropped or replaced by name.

-- ── 1. social_settings: only a settings manager writes the publish lock ─────
do $$
begin
  if to_regclass('public.social_settings') is null then
    return;
  end if;

  drop policy if exists social_settings_manage_settings_insert_guard on public.social_settings;
  create policy social_settings_manage_settings_insert_guard on public.social_settings
    as restrictive for insert to authenticated, anon
    with check (public.social_has_permission(family_id, 'manage_settings'));

  -- Both halves: USING picks the row a caller may change, WITH CHECK the row
  -- they may leave behind. Same predicate, stated twice so a later change to
  -- one cannot silently reuse the other.
  drop policy if exists social_settings_manage_settings_update_guard on public.social_settings;
  create policy social_settings_manage_settings_update_guard on public.social_settings
    as restrictive for update to authenticated, anon
    using (public.social_has_permission(family_id, 'manage_settings'))
    with check (public.social_has_permission(family_id, 'manage_settings'));

  drop policy if exists social_settings_manage_settings_delete_guard on public.social_settings;
  create policy social_settings_manage_settings_delete_guard on public.social_settings
    as restrictive for delete to authenticated, anon
    using (public.social_has_permission(family_id, 'manage_settings'));
end
$$;

-- ── 2. vacation_documents: a trip links only a document you could read ──────
create or replace function public.vacation_document_link_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $guard$
begin
  -- No pointer, nothing to check: the Trip -> Documents form never sets one,
  -- and ON DELETE SET NULL clears one when its document is deleted.
  if new.document_id is null then
    return new;
  end if;

  -- An UPDATE that leaves the pointer and the household alone is not setting
  -- anything — a member editing the notes on a parent-linked row passes.
  if tg_op = 'UPDATE'
     and new.document_id is not distinct from old.document_id
     and new.family_id   is not distinct from old.family_id then
    return new;
  end if;

  -- Asked as the caller, so documents_select decides visibility. Positive on
  -- purpose: a row the caller cannot see is a link the caller cannot make.
  if exists (
    select 1
      from public.documents d
     where d.id = new.document_id
       and d.family_id = new.family_id
  ) then
    return new;
  end if;

  raise exception
    'a trip may only link a document of its own family that you are allowed to open'
    using errcode = '42501';
end;
$guard$;

-- Never called directly; firing a trigger does not check EXECUTE (0344:330).
revoke all on function public.vacation_document_link_guard() from public, anon, authenticated;

do $$
declare
  cleared integer;
begin
  if to_regclass('public.vacation_documents') is null then
    return;
  end if;

  -- A pointer written before this guard existed at ANOTHER household's
  -- document is invalid whoever wrote it: clear it, as ON DELETE SET NULL
  -- would, and say how many. Run as the migration owner, so RLS hides nothing
  -- and the NOT EXISTS here is a statement about every documents row.
  if to_regclass('public.documents') is not null then
    update public.vacation_documents v
       set document_id = null
     where v.document_id is not null
       and not exists (
         select 1
           from public.documents d
          where d.id = v.document_id
            and d.family_id = v.family_id
       );
    get diagnostics cleared = row_count;
    if cleared > 0 then
      raise notice '0365: cleared % vacation_documents.document_id pointer(s) at another household''s document', cleared;
    end if;
  end if;

  drop trigger if exists trg_vacation_documents_link_guard on public.vacation_documents;
  create trigger trg_vacation_documents_link_guard
    before insert or update of document_id, family_id on public.vacation_documents
    for each row execute function public.vacation_document_link_guard();
end
$$;

-- ── 3. documents: a document a trip links does not leave that household ─────
create or replace function public.documents_linked_trip_stays_home()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $home$
begin
  -- Every link, not the caller's view of them: see the header, section 3.
  if exists (
    select 1
      from public.vacation_documents v
     where v.document_id = new.id
       and v.family_id is distinct from new.family_id
  ) then
    raise exception
      'a document a trip links cannot move to another household; unlink it from the trip first'
      using errcode = '42501';
  end if;
  return new;
end;
$home$;

revoke all on function public.documents_linked_trip_stays_home() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.documents') is null or to_regclass('public.vacation_documents') is null then
    return;
  end if;

  drop trigger if exists trg_documents_linked_trip_stays_home on public.documents;
  create trigger trg_documents_linked_trip_stays_home
    before update of family_id on public.documents
    for each row when (new.family_id is distinct from old.family_id)
    execute function public.documents_linked_trip_stays_home();
end
$$;

-- Fail loudly if the guards are not in force, rather than leaving a migration
-- that "applied" against tables still open to a child.
do $$
declare
  n integer;
begin
  if to_regclass('public.social_settings') is not null then
    select count(*) into n
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relname = 'social_settings'
       and not p.polpermissive
       and p.polname in (
         'social_settings_manage_settings_insert_guard',
         'social_settings_manage_settings_update_guard',
         'social_settings_manage_settings_delete_guard');
    if n <> 3 then
      raise exception 'social_settings manage_settings write guards are not in force (found % of 3)', n;
    end if;
  end if;

  if to_regclass('public.vacation_documents') is not null then
    select count(*) into n
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_proc f on f.oid = t.tgfoid
     where ns.nspname = 'public'
       and c.relname = 'vacation_documents'
       and t.tgname = 'trg_vacation_documents_link_guard'
       and t.tgenabled <> 'D'
       and f.proname = 'vacation_document_link_guard'
       and not f.prosecdef;
    if n <> 1 then
      raise exception 'vacation_documents link guard is not in force as a SECURITY INVOKER trigger (found % of 1)', n;
    end if;
  end if;

  if to_regclass('public.documents') is not null and to_regclass('public.vacation_documents') is not null then
    select count(*) into n
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_proc f on f.oid = t.tgfoid
     where ns.nspname = 'public'
       and c.relname = 'documents'
       and t.tgname = 'trg_documents_linked_trip_stays_home'
       and t.tgenabled <> 'D'
       and f.proname = 'documents_linked_trip_stays_home'
       and f.prosecdef;
    if n <> 1 then
      raise exception 'documents household-move guard is not in force as a SECURITY DEFINER trigger (found % of 1)', n;
    end if;
    if has_function_privilege('anon', 'public.documents_linked_trip_stays_home()', 'execute')
       or has_function_privilege('authenticated', 'public.documents_linked_trip_stays_home()', 'execute') then
      raise exception 'documents_linked_trip_stays_home is SECURITY DEFINER and still executable by anon or authenticated';
    end if;
  end if;
end
$$;
