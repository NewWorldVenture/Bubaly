-- Bubaly :: 0486 - an Autopilot card is read by its audience
-- ----------------------------------------------------------------------------
-- From the 2026-10-12 family-life audit (PR #1031), the database half of
-- lib/autopilot/audience.ts. Numbered 0486 as the next free number: under the
-- owner decision of 2026-10-10 the holders the preserved map lists for
-- 0477-0487 take the next free number when they land, and 0486 was free
-- ("Numbering from 0475 on", docs/PENDING_PROD_MIGRATIONS.md); 0487 stays
-- free. The migrations held in supabase/reserved/ are untouched.
--
-- An Autopilot card is a COPY of a source row as the scan saw it: a
-- subscription's name and amount, a renewal's title, an insurance policy's
-- type and insurer. The nightly scan runs on the service role, so the copy is
-- made past every rule that narrows the source, and `autopilot_suggestions`
-- is then read under 0085's `FOR ALL TO authenticated USING
-- (is_family_member(family_id))`; 0327 closed DELETE and pinned resolved_by
-- and left SELECT as it was. audience.ts decides who each card is for and every
-- screen filters by it, but nothing below the screens did. Reproduced natively
-- (installed SDK -> PostgREST -> Postgres): an active guest gets zero rows of
-- `subscriptions_tracked` and `renewals`, which 0481 refuses them, and reads
-- the cards copied from both, title, detail and payload ("$15.99 charge:
-- Netflix tomorrow", "Renew Passport").
--
-- The rule is audience.ts's suggestionAudience/suggestionVisibleTo, in its
-- order (the insurance test is made first, so a card that is both is the
-- narrower one's):
--
--   policy-readers  source_kind 'family_insurance_policies' or kind 'insurance'
--                   -> a manager (can_manage_family, 0003: parent or adult,
--                   active) or the member the policy names. The scan reads
--                   family_insurance_policies.member_id into the snapshot
--                   (lib/autopilot/scan.ts), the engine's insurance draft
--                   carries it as memberId (lib/autopilot/engine.ts), and the
--                   scan stores it as the card's member_id; is_self_member
--                   (0272) is whether that member row is the caller's own,
--                   active. A card naming nobody is the managers'.
--   not-guests      kind 'finance' or source_kind 'subscriptions_tracked' or
--                   'renewals' -> anyone whose role in the family is not
--                   guest: 0481's own test on those two tables,
--                   `family_role(family_id) is distinct from 'guest'`.
--   everyone        anything else -> no narrowing.
--
-- Two RESTRICTIVE policies TO authenticated over that one CASE, one FOR
-- SELECT and one FOR UPDATE, ANDed with 0085's permissive policy, so
-- membership of the card's family is still required and an inactive member,
-- another family's member and `anon` (no policy at all) still read nothing;
-- and one BEFORE UPDATE trigger (below, "An UPDATE that reads no column").
-- The policies reuse the helpers 0464, 0481 and the held 0517 use; the
-- trigger's function is the only thing defined here. The service role
-- bypasses RLS and the trigger, so the nightly scan and the notifications
-- generator are unchanged.
--
-- What it does to writes, which is why the scan changes with it. A SELECT
-- policy also applies to a write that reads its row: an UPDATE with a WHERE
-- or RETURNING sees only rows the caller may read and must still be able to
-- read the new row, and an INSERT ... RETURNING must be able to read what it
-- inserted. So a reader resolves a card exactly as before (resolveSuggestion's
-- update ... select; trust actions' policy cards are everyone's), and a
-- non-reader's resolve matches no row, which the app already answers as
-- notFound for a card it does not show them. The on-demand scan
-- (app/api/autopilot/scan, `createServer()`, the CALLER's client) inserts with
-- `.select('id')`; a card its caller may not read would be refused 42501 and
-- fail the whole scan (0327 explains why that scan stays open to every
-- member). lib/autopilot/scan.ts therefore skips a draft its caller may not
-- read; the nightly scan or a reader's own scan writes it. INSERT and DELETE
-- policies, and 0327's three guards, are not changed.
--
-- ── An UPDATE that reads no column (RV486-2) ────────────────────────────────
--
-- "A SELECT policy also applies to a write that reads its row" is the whole
-- of it: Postgres adds SELECT policies to an UPDATE only when the statement
-- needs SELECT on the table, i.e. when its WHERE, its RETURNING or a SET
-- expression names a column of it. Replayed on PG16, as the unnamed teen with
-- the SELECT policy alone:
--
--   update public.autopilot_suggestions set member_id = '<own member id>'
--     -> every card of the family, Ava's insurance card included, now names
--        the teen, and the teen reads it (`where true`, `returning 1` and a
--        SET of `(select id from family_members where user_id = auth.uid())`
--        are the same: none names a column);
--   update public.autopilot_suggestions set kind = 'other', source_kind = null
--     -> as the guest: the subscription charge is an "other" card and the
--        guest reads "$15.99 charge: Netflix tomorrow";
--   PostgREST's PATCH with no filter and return=minimal
--     -> the same: its mutation CTE sets from the JSON body and returns 1.
--
-- Forms that name a column are already held by the SELECT policy, on the old
-- row (filtered) and on the new one (refused 42501): a PATCH with any filter
-- (`?family_id=eq.…` and every other PostgREST filter names a column),
-- `returning id`, `set title = title`. Hosted Supabase may refuse an
-- unfiltered PostgREST UPDATE before it gets here (pg-safeupdate); nothing in
-- this repository can show that, and these guards do not rely on it.
--
-- Two things close it:
--
--   1. RESTRICTIVE FOR UPDATE TO authenticated, USING and WITH CHECK both the
--      same CASE. An UPDATE policy applies to every UPDATE, whatever it names:
--      USING means a caller updates only rows they may read, so a non-reader
--      cannot touch a card at all; WITH CHECK means the row it leaves must
--      still be one the CALLER may read. That stops every relabel of the
--      card's member that lands outside the caller's audience: a named child
--      moving her card to a sibling (or to nobody, the managers'), a teen or a
--      guest naming themselves on a card they could not read (they could not
--      reach it). It cannot stop a reader whose new row is still theirs to
--      read, which is (2)'s.
--      A manager reads every card, so a manager may still say whose policy a
--      card is; that is the Insurance Hub's decision and it is how the scan
--      keeps a card in step with a reassigned policy (below).
--   2. A BEFORE UPDATE trigger that pins the columns that decide who reads a
--      card, `kind`, `source_kind` and `family_id`, for every caller subject
--      to RLS. The policy sees only the NEW row, and a READER who widens a
--      card ends inside their own audience: the teen who may read the
--      subscription charge turns it into kind 'other' and passes any check on
--      the new row, and the guest reads it. Only the old row can tell that
--      from an honest resolve, which is a trigger's (0480's pattern, and its
--      bypass test: a role that bypasses RLS bypasses this). `kind` and
--      `source_kind` are what audience.ts classifies a card by. `family_id`
--      is an argument of every helper in the CASE (can_manage_family,
--      family_role) and of 0085's membership test, so it decides the audience
--      as much as the other two (RV486-2-FAMILY): replayed on PG16 with only
--      those two pinned, Ava, a child in this family and in her co-parent's,
--      moved her insurance card into the other family by id (`set family_id
--      = '<B>' … returning id`), the other family's parent read it and this
--      family's adult no longer did; Sam, a teen in both, did the same to
--      the subscription charge by PostgREST's filtered PATCH; a guest here
--      who runs her own household moved an ordinary card into it. Every check
--      passed: 0085's WITH CHECK is membership of the NEW family, which they
--      have; this policy's USING read the old row, its WITH CHECK the new one
--      (`is_self_member(member_id)` does not ask which family, and the teen's
--      role in the other family is not guest); 0327's update guard asks only
--      membership of the old family and who resolved.
--      Moving a card out of its family is also the delete 0327 refuses every
--      client. With the three pinned no client changes which audience a card
--      has, either way: `member_id` is the only column a client can still
--      write that decides who reads a card, and only on an insurance card,
--      where (1) holds it. Nothing in app/ or lib/ updates any of the three
--      (resolve, archive, the policy refresh and the trust actions write
--      status, resolved_*, dedupe_key, expires_at, detail, confidence,
--      payload; the scan's refresh writes member_id, by id AND family_id), so
--      the pin costs no flow. A manager is pinned too: no client rewrites
--      what a card is a copy of or whose family it is.
--
-- ── Insurance cards written before the scan stored their member ─────────────
--
-- The scan stores the policy's member as the card's member_id
-- (family_insurance_policies.member_id, read into the snapshot); cards written
-- before it did carry member_id NULL. Under this policy such a card is the
-- managers' alone, so the member the policy names cannot read their own
-- renewal (no leak, but a regression of audience.ts), and their own
-- on-demand scan drafts it, cannot see the prior row, inserts, meets
-- UNIQUE(family_id, dedupe_key) (23505), removes the reminder it made and
-- carries on, every time they open Autopilot. The backfill below, BEFORE the
-- policies, names that member on every card whose policy names one:
-- autopilot_suggestions.source_id and family_insurance_policies.id are both
-- uuid (0085, 0084), matched within the same family_id, and only a card with
-- no member is touched, so it is idempotent and never overrides a member the
-- scan wrote. Triggers on autopilot_suggestions, from the migrations and the
-- replayed catalog: 0085's trg_autopilot_suggestions_updated_at (BEFORE
-- UPDATE, set_updated_at(): bumps updated_at, which resolveSuggestion uses as
-- its concurrency token, so a screen open across the release answers
-- "changed" once and reloads), the foreign-key checks (member_id names a
-- family_members row: the policy's own member_id does), and this migration's
-- pin, which is created after the backfill, does not pin member_id and is
-- bypassed by the migration role. None refuses it.
--
-- A policy reassigned to another member is the scan's to follow:
-- lib/autopilot/scan.ts refreshes a prior insurance card's member_id when the
-- policy names someone other than the card does (a legacy card this backfill
-- did not reach included, and a policy that now names no one), on the nightly scan
-- and on a manager's own scan, never on a scan by a member who may not read
-- both the old card and the new one. The window that leaves: from the
-- reassignment until the next nightly or manager scan, the newly named member
-- cannot read the card (their own scan still takes the 23505 path) and the
-- previously named member still reads it.
--
-- What stays outside it:
--
--   * The reminders a card makes. An auto-executed card writes a `reminders`
--     row (related_type 'renewal', related_id the source) and a reader's "Add
--     reminder" a `family_reminders` row (the card's idempotency key); both
--     carry the card's words, and both tables still read family-wide in RLS.
--     The app hides them per card in lib/autopilot/reminder-cards.ts by
--     READING the card. Under this policy a reader the card is not for no
--     longer finds it, so that lookup reads every create_reminder card its
--     reader may read (an everyone card's too: a refill's reminder is also
--     related_type 'renewal') and answers a reminder that looks like a card's
--     whose card it does not find as the managers' alone, the answer it gives
--     a failed read; changed with this migration, before it is applied, and
--     the same answer without it (tests/a-cards-reminder-stays-with-its-
--     readers-when-the-card-is-not-theirs-to-read.test.ts, both schemas).
--     A screen that lists these rows without that lookup, or a direct read of
--     either table, still shows them to the family: the reminder rows need a
--     read rule of their own.
--   * The insurance source. family_insurance_policies (0416) still reads
--     family-wide: the held 0517 narrows it to managers and its member. Until
--     it lands any member reads the policy row this card copies; this closes
--     the copy, not the source.
--
-- Probe: docs/audit/an-autopilot-card-is-read-by-its-audience-check.sql (the
-- read rule, the column-free UPDATE, the pin, a move into another family the
-- writer also belongs to, and this file's backfill re-applied in its
-- transaction). docs/audit/autopilot-suggestion-write-check.sql (0327) still
-- holds: its cards are everyone's.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md);
-- the owner applies it in the normal manual release.
--
-- Idempotent: the backfill touches only a card with no member, so a second run
-- writes no row; the function is created or replaced, and the policies and
-- the trigger are dropped if they exist before they are created.

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    raise exception '0486: public.autopilot_suggestions (0085) does not exist';
  end if;
  if to_regclass('public.family_insurance_policies') is null then
    raise exception '0486: public.family_insurance_policies (0084) does not exist';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null
     or to_regprocedure('public.family_role(uuid)') is null then
    raise exception '0486 needs can_manage_family, is_self_member and family_role';
  end if;
end
$$;

-- ── a legacy insurance card names the member its policy names ──────────────
-- Before the policies: a card written before the scan stored the policy's
-- member is otherwise the managers' alone, and its member's own scan meets
-- 23505 on every open. Only a card with no member, so a member the scan wrote
-- is never overridden and a second run writes nothing.
do $$
declare
  v_named bigint;
begin
  update public.autopilot_suggestions s
     set member_id = p.member_id
    from public.family_insurance_policies p
   where s.source_kind = 'family_insurance_policies'
     and s.source_id = p.id
     and s.family_id = p.family_id
     and s.member_id is null
     and p.member_id is not null;
  get diagnostics v_named = row_count;
  raise notice '0486: % insurance card(s) written before the scan stored the policy''s member now name it', v_named;
end
$$;

drop policy if exists autopilot_suggestions_audience_read_guard on public.autopilot_suggestions;
create policy autopilot_suggestions_audience_read_guard on public.autopilot_suggestions
  as restrictive for select to authenticated
  using (
    case
      when source_kind = 'family_insurance_policies' or kind = 'insurance'
        then public.can_manage_family(family_id) or public.is_self_member(member_id)
      when kind = 'finance' or source_kind in ('subscriptions_tracked', 'renewals')
        then public.family_role(family_id) is distinct from 'guest'
      else true
    end
  );

comment on policy autopilot_suggestions_audience_read_guard on public.autopilot_suggestions is
  'A card is read by its audience (lib/autopilot/audience.ts, 0486): an insurance renewal by a manager or the member the policy names; a subscription charge or a renewal by anyone but a guest; anything else by the family (0085). An UPDATE that names no column skips this policy; autopilot_suggestions_audience_update_guard holds that one.';

-- The same CASE, on every UPDATE whatever it names (RV486-2): USING, a caller
-- updates only a card they may read; WITH CHECK, the card they leave is still
-- one they may read.
drop policy if exists autopilot_suggestions_audience_update_guard on public.autopilot_suggestions;
create policy autopilot_suggestions_audience_update_guard on public.autopilot_suggestions
  as restrictive for update to authenticated
  using (
    case
      when source_kind = 'family_insurance_policies' or kind = 'insurance'
        then public.can_manage_family(family_id) or public.is_self_member(member_id)
      when kind = 'finance' or source_kind in ('subscriptions_tracked', 'renewals')
        then public.family_role(family_id) is distinct from 'guest'
      else true
    end
  )
  with check (
    case
      when source_kind = 'family_insurance_policies' or kind = 'insurance'
        then public.can_manage_family(family_id) or public.is_self_member(member_id)
      when kind = 'finance' or source_kind in ('subscriptions_tracked', 'renewals')
        then public.family_role(family_id) is distinct from 'guest'
      else true
    end
  );

comment on policy autopilot_suggestions_audience_update_guard on public.autopilot_suggestions is
  'A card is updated only by its audience, and only into a card its writer may still read (0486, RV486-2): the read rule of autopilot_suggestions_audience_read_guard on the old row (USING) and the new row (WITH CHECK), for every UPDATE, including one that names no column and so skips the SELECT policy. With autopilot_suggestion_keeps_its_audience, which pins kind, source_kind and family_id (a reader''s widening, or a move into another family the writer also belongs to, passes a check on either row alone), a non-reader cannot touch a card and a reader cannot relabel one for someone outside its audience.';

-- ── what a card is a copy of, and whose family it is, is the scan's ─────────
-- (RV486-2, RV486-2-FAMILY)
create or replace function public.autopilot_suggestion_keeps_its_audience()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  -- The server bypasses row-level security, and so does this (0480).
  select r.rolsuper or r.rolbypassrls into v_bypass
  from pg_catalog.pg_roles r
  where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;

  if new.kind is distinct from old.kind
     or new.source_kind is distinct from old.source_kind
     or new.family_id is distinct from old.family_id then
    raise exception 'what an Autopilot card is a copy of and whose family it is (kind, source_kind, family_id) decide who reads it and cannot be rewritten (0486)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.autopilot_suggestion_keeps_its_audience() is
  'BEFORE UPDATE on autopilot_suggestions, for callers subject to RLS: kind, source_kind and family_id, the columns that decide who reads a card (lib/autopilot/audience.ts classifies it by the first two; every helper in the read rule, and 0085''s membership, takes the third), never change after insert. So a reader cannot widen a card (a finance card turned into an everyone card), narrow one past the update guard, which sees only the new row, or move one into another family they also belong to, where that family''s readers read it and its own family loses it (0486).';

revoke all on function public.autopilot_suggestion_keeps_its_audience() from public, anon, authenticated;

drop trigger if exists autopilot_suggestions_keep_their_audience on public.autopilot_suggestions;
create trigger autopilot_suggestions_keep_their_audience
  before update on public.autopilot_suggestions
  for each row execute function public.autopilot_suggestion_keeps_its_audience();

-- ── self-check ───────────────────────────────────────────────────────────────
do $$
declare
  v_read text;
  v_update_using text;
  v_update_check text;
  v_legacy bigint;
begin
  select qual into v_read from pg_policies
   where schemaname = 'public' and tablename = 'autopilot_suggestions'
     and policyname = 'autopilot_suggestions_audience_read_guard'
     and permissive = 'RESTRICTIVE' and cmd = 'SELECT' and roles = '{authenticated}'::name[];
  if v_read is null then
    raise exception '0486: the audience read guard on autopilot_suggestions is missing or is not RESTRICTIVE FOR SELECT TO authenticated';
  end if;
  select qual, with_check into v_update_using, v_update_check from pg_policies
   where schemaname = 'public' and tablename = 'autopilot_suggestions'
     and policyname = 'autopilot_suggestions_audience_update_guard'
     and permissive = 'RESTRICTIVE' and cmd = 'UPDATE' and roles = '{authenticated}'::name[];
  if v_update_using is null or v_update_check is null then
    raise exception '0486: the audience update guard on autopilot_suggestions is missing, is not RESTRICTIVE FOR UPDATE TO authenticated, or lacks USING or WITH CHECK';
  end if;
  if v_update_using is distinct from v_read or v_update_check is distinct from v_read then
    raise exception '0486: the audience update guard does not apply the read guard''s rule on both rows';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.autopilot_suggestions'::regclass
       and t.tgname = 'autopilot_suggestions_keep_their_audience'
       and t.tgenabled = 'O'
       and t.tgfoid = 'public.autopilot_suggestion_keeps_its_audience()'::regprocedure
  ) then
    raise exception '0486: the trigger pinning a card''s kind, source_kind and family_id is missing or disabled';
  end if;
  if has_function_privilege('anon', 'public.autopilot_suggestion_keeps_its_audience()', 'execute')
     or has_function_privilege('authenticated', 'public.autopilot_suggestion_keeps_its_audience()', 'execute') then
    raise exception '0486: autopilot_suggestion_keeps_its_audience is executable by a client role';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'autopilot_suggestions'
       and policyname = 'Members manage autopilot_suggestions' and permissive = 'PERMISSIVE' and cmd = 'ALL'
  ) then
    raise exception '0486: 0085''s membership policy on autopilot_suggestions is gone';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'autopilot_suggestions'
         and policyname in ('autopilot_suggestions_no_client_delete_guard',
                            'autopilot_suggestions_resolver_guard',
                            'autopilot_suggestions_resolver_update_guard')) <> 3 then
    raise exception '0486: 0327''s guards on autopilot_suggestions are not all there';
  end if;
  select count(*) into v_legacy
    from public.autopilot_suggestions s
    join public.family_insurance_policies p
      on p.id = s.source_id and p.family_id = s.family_id
   where s.source_kind = 'family_insurance_policies'
     and s.member_id is null and p.member_id is not null;
  if v_legacy <> 0 then
    raise exception '0486: % insurance card(s) still name no member although their policy names one', v_legacy;
  end if;
  raise notice '0486 OK: an Autopilot card is read and updated by its audience (insurance: managers and its member; subscriptions and renewals: not guests; the rest: the family), its kind, source_kind and family are the server''s, and every insurance card names the member its policy names';
end
$$;
