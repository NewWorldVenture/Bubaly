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
-- One RESTRICTIVE policy FOR SELECT TO authenticated, ANDed with 0085's
-- permissive policy, so membership of the card's family is still required
-- and an inactive member, another family's member and `anon` (no policy at
-- all) still read nothing. It reuses the helpers 0464, 0481 and the held 0517
-- use; nothing new is defined. The service role bypasses RLS, so the nightly
-- scan and the notifications generator are unchanged.
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
-- read; the nightly scan or a reader's own scan writes it. INSERT, UPDATE and
-- DELETE policies, and 0327's three guards, are not changed.
--
-- What stays outside it:
--
--   * The reminders a card makes. An auto-executed card writes a `reminders`
--     row (related_type 'renewal', related_id the source) and a reader's "Add
--     reminder" a `family_reminders` row (the card's idempotency key); both
--     carry the card's words, and both tables still read family-wide in RLS.
--     The app hides them per card in lib/autopilot/reminder-cards.ts by
--     READING the card, and answers a card it cannot find as "not a card's
--     reminder". Under this policy a reader the card is not for no longer
--     finds it, so that lookup must answer an unfound card the managers' way
--     before this is applied (recorded with the release dependency in
--     docs/PENDING_PROD_MIGRATIONS.md). The reminder rows need a read rule of
--     their own.
--   * The insurance source. family_insurance_policies (0416) still reads
--     family-wide: the held 0517 narrows it to managers and its member. Until
--     it lands any member reads the policy row this card copies; this closes
--     the copy, not the source.
--
-- Probe: docs/audit/an-autopilot-card-is-read-by-its-audience-check.sql.
-- docs/audit/autopilot-suggestion-write-check.sql (0327) still holds: its
-- cards are everyone's.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md);
-- the owner applies it in the normal manual release.
--
-- Idempotent: the policy is dropped if it exists before it is created.

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    raise exception '0486: public.autopilot_suggestions (0085) does not exist';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null
     or to_regprocedure('public.family_role(uuid)') is null then
    raise exception '0486 needs can_manage_family, is_self_member and family_role';
  end if;
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
  'A card is read by its audience (lib/autopilot/audience.ts, 0486): an insurance renewal by a manager or the member the policy names; a subscription charge or a renewal by anyone but a guest; anything else by the family (0085).';

-- ── self-check ───────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'autopilot_suggestions'
       and policyname = 'autopilot_suggestions_audience_read_guard'
       and permissive = 'RESTRICTIVE' and cmd = 'SELECT' and roles = '{authenticated}'::name[]
  ) then
    raise exception '0486: the audience read guard on autopilot_suggestions is missing or is not RESTRICTIVE FOR SELECT TO authenticated';
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
  raise notice '0486 OK: an Autopilot card is read by its audience (insurance: managers and its member; subscriptions and renewals: not guests; the rest: the family)';
end
$$;
