-- Bubaly :: 0481 - the RLS sweep narrows the household tables to their roles
-- ----------------------------------------------------------------------------
-- The 2026-10-10 RLS sweep (proposed-rls-sweep.fixed.sql, tested against the
-- full probe suite). Every high and medium finding: a guest views and does not
-- write; a member writes only their own rows where the screen says so; a manager
-- keeps everything. Numbered 0481 by owner decision of 2026-10-10; the SQL is
-- the proposal's, unchanged. Each [FIX n] note below records where the sweep's
-- first draft broke an existing probe and how the fixed draft keeps it.
--
-- Probe: docs/audit/rls-sweep-check.sql (both directions for every finding).
-- Four existing probes carry fixture or allowlist edits for the narrowing this
-- makes on purpose: a-password-alone-does-not-open-the-familys-vault-check,
-- gated-write-tables-check, health-record-boundary-check and
-- reward-redemption-decision-check.


-- medication_doses (high)
do $$
begin
  if to_regclass('public.medication_doses') is null then return; end if;
  execute 'drop policy if exists "Members can manage medication_doses" on public.medication_doses';
  execute 'drop policy if exists medication_doses_select on public.medication_doses';
  execute 'drop policy if exists medication_doses_insert on public.medication_doses';
  execute 'drop policy if exists medication_doses_update on public.medication_doses';
  execute 'drop policy if exists medication_doses_delete on public.medication_doses';
  -- managers see the family; everyone else sees only doses of medicine prescribed to them
  execute 'create policy medication_doses_select on public.medication_doses for select to authenticated using (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id)))';
  execute 'create policy medication_doses_insert on public.medication_doses for insert to authenticated with check (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id)))';
  execute 'create policy medication_doses_update on public.medication_doses for update to authenticated using (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id))) with check (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id)))';
  execute 'create policy medication_doses_delete on public.medication_doses for delete to authenticated using (public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id)))';
  -- restrictive guards so a re-added permissive policy cannot reopen it
  execute 'drop policy if exists medication_doses_owner_select_guard on public.medication_doses';
  execute 'create policy medication_doses_owner_select_guard on public.medication_doses as restrictive for select to authenticated using (public.can_manage_family(family_id) or public.is_self_member(member_id))';
  execute 'drop policy if exists medication_doses_owner_write_guard on public.medication_doses';
  execute 'create policy medication_doses_owner_write_guard on public.medication_doses as restrictive for all to authenticated using (public.can_manage_family(family_id) or public.is_self_member(member_id)) with check (public.can_manage_family(family_id) or public.is_self_member(member_id))';
  -- the dose must belong to the medication's own member; a family-wide medication (member_id null)
  -- is dosed by whoever takes it (the insert policy above still pins member_id to the caller or a manager).
  -- [FIX 1] was `m.member_id is not distinct from medication_doses.member_id`, which refused the
  -- dose prescription-write-boundary-check.sql asserts a member can still record.
  execute 'drop policy if exists medication_doses_matches_med_guard on public.medication_doses';
  execute 'create policy medication_doses_matches_med_guard on public.medication_doses as restrictive for insert to authenticated with check (exists (select 1 from public.medications m where m.id = medication_id and m.family_id = medication_doses.family_id and (m.member_id is null or m.member_id is not distinct from medication_doses.member_id)))';
end $$;
-- medication_doses_attribution_guard (0338) and the attribution_immutable trigger are kept unchanged.

-- tax_documents (high)
-- tax_documents: reads are for managers and the member a document is about. Writes are manager-only.
-- 0391's restrictive step-up guards stay in place and keep ANDing with these.
-- (components/modules/tax-vault-module.tsx should also gate add/delete on isManager(role).)
do $$
begin
  if to_regclass('public.tax_documents') is null then return; end if;
  execute 'drop policy if exists "Members manage tax_documents" on public.tax_documents';
  execute 'drop policy if exists tax_documents_select on public.tax_documents';
  execute 'drop policy if exists tax_documents_insert on public.tax_documents';
  execute 'drop policy if exists tax_documents_update on public.tax_documents';
  execute 'drop policy if exists tax_documents_delete on public.tax_documents';
  execute 'create policy tax_documents_select on public.tax_documents for select to authenticated using ('
       || 'public.can_manage_family(family_id) '
       || 'or (member_id is not null and public.is_self_member(member_id) '
       || '    and public.family_role(family_id) in (''teen'',''child'')))';
  execute 'create policy tax_documents_insert on public.tax_documents for insert to authenticated with check (public.can_manage_family(family_id))';
  execute 'create policy tax_documents_update on public.tax_documents for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))';
  execute 'create policy tax_documents_delete on public.tax_documents for delete to authenticated using (public.can_manage_family(family_id))';
end
$$;

-- chore_disputes (medium)
-- chore_disputes: deleting a dispute belongs to its own member while it is still open, or to a manager; a filed dispute must be against the filer's own submission
drop policy if exists chore_disputes_member_owns_it_delete on public.chore_disputes;
create policy chore_disputes_member_owns_it_delete on public.chore_disputes
  as restrictive for delete to authenticated
  using (
    public.can_manage_family(family_id)
    or (public.is_self_member(member_id) and status = 'open')
  );

drop policy if exists chore_disputes_submission_is_the_members on public.chore_disputes;
create policy chore_disputes_submission_is_the_members on public.chore_disputes
  as restrictive for insert to authenticated
  with check (
    public.can_manage_family(family_id)
    or exists (
      select 1 from public.chore_submissions s
      where s.id = chore_disputes.submission_id
        and s.family_id = chore_disputes.family_id
        and s.member_id = chore_disputes.member_id
    )
  );

-- calendar_feeds (medium)
-- calendar_feeds: a guest views the household calendar but does not subscribe it to new sources (extends 0464)
do $$
begin
  if to_regclass('public.calendar_feeds') is null then return; end if;
  drop trigger if exists trg_calendar_feeds_not_a_guests on public.calendar_feeds;
  create trigger trg_calendar_feeds_not_a_guests
    before insert or update or delete on public.calendar_feeds
    for each row execute function public.household_write_is_not_a_guests();
end $$;

-- behavior_logs (medium)
-- behavior_logs: a manager logs about anyone; any other non-guest member logs only about themselves.
-- [FIX 2] Narrowed from manager-only. 0338/0377 record "anyone in the family may log" as the
-- database rule (behavior-module.tsx:44-48: the manager-only screen is the UI half only, and the owner
-- decides), and three probes pin a child logging a note about THEMSELVES
-- (a-care-entry-names-who-logged-it, behavior-log, access-record-write-boundary). This keeps that and
-- closes the sibling-targeting and guest halves of the finding. Making logging manager-only needs the
-- owner's decision and those three probes changed.
drop policy if exists behavior_logs_manager_insert_guard on public.behavior_logs;
create policy behavior_logs_manager_insert_guard on public.behavior_logs
  as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id)
              or (public.is_self_member(member_id) and public.family_role(family_id) is distinct from 'guest'));

-- [FIX 2b] The optional guest-read guard is NOT applied: member-scope-crossing-check.sql pins
-- behavior_logs to exactly one SELECT policy (is_family_member) and no restrictive SELECT policy.
-- Owner decision + probe change required:
-- drop policy if exists behavior_logs_not_a_guests_read on public.behavior_logs;
-- create policy behavior_logs_not_a_guests_read on public.behavior_logs
--   as restrictive for select to authenticated
--   using (public.family_role(family_id) is distinct from 'guest');

-- expense_split_shares (medium)
do $$
declare p record;
begin
  if to_regclass('public.expense_split_shares') is null then return; end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='expense_split_shares' and permissive='PERMISSIVE' loop
    execute format('drop policy %I on public.expense_split_shares', p.policyname);
  end loop;
  -- read: every member except a guest (guests view shared events only)
  create policy expense_split_shares_select on public.expense_split_shares for select to authenticated
    using (public.is_family_member(family_id) and public.family_role(family_id) is distinct from 'guest');
  -- create: a manager, or the non-guest/non-caregiver member who created the parent split (the expenses-module flow), and the split must be in the same family
  create policy expense_split_shares_insert on public.expense_split_shares for insert to authenticated
    with check (public.is_family_member(family_id)
      and public.family_role(family_id) not in ('guest','caregiver')
      and exists (select 1 from public.expense_splits s where s.id = split_id and s.family_id = expense_split_shares.family_id
                  and (public.can_manage_family(s.family_id) or s.created_by = auth.uid())));
  -- settle/unsettle: a manager, the debtor themself, or the payer/creator of the split
  create policy expense_split_shares_update on public.expense_split_shares for update to authenticated
    using (public.is_family_member(family_id) and public.family_role(family_id) not in ('guest','caregiver')
      and (public.can_manage_family(family_id) or public.is_self_member(member_id)
           or exists (select 1 from public.expense_splits s where s.id = split_id and (s.created_by = auth.uid() or public.is_self_member(s.paid_by)))))
    -- [FIX 3] same predicates, written as `<split is this family's> and (<USING>)` so the WITH CHECK
    -- textually contains the USING (marketplace-deal-terms-check.sql's asymmetric-UPDATE sweep).
    with check (exists (select 1 from public.expense_splits s where s.id = split_id and s.family_id = expense_split_shares.family_id)
      and (public.is_family_member(family_id) and public.family_role(family_id) not in ('guest','caregiver')
      and (public.can_manage_family(family_id) or public.is_self_member(member_id)
           or exists (select 1 from public.expense_splits s where s.id = split_id and (s.created_by = auth.uid() or public.is_self_member(s.paid_by))))));
  create policy expense_split_shares_delete on public.expense_split_shares for delete to authenticated
    using (public.is_family_member(family_id)
      and (public.can_manage_family(family_id)
           or (public.family_role(family_id) not in ('guest','caregiver')
               and exists (select 1 from public.expense_splits s where s.id = split_id and s.created_by = auth.uid()))));
end $$;
-- Optional follow-up (product decision): a non-manager debtor should only flip settled/settled_at, not share_cents/member_id/split_id. Enforce it with a BEFORE UPDATE trigger that raises 42501 when not can_manage_family(new.family_id) and (new.share_cents, new.member_id, new.split_id, new.family_id) is distinct from (old.share_cents, old.member_id, old.split_id, old.family_id).
revoke insert, update, delete, truncate on public.expense_split_shares from anon;

-- chore_submissions (medium)
-- 1) bind a submission to whose chore it is (restrictive, ANDs with 0375's permissive policies)
drop policy if exists chore_submissions_assignment_guard_insert on public.chore_submissions;
create policy chore_submissions_assignment_guard_insert on public.chore_submissions as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id) or exists (
    select 1 from public.chore_assignments a where a.id = assignment_id and a.family_id = chore_submissions.family_id and a.member_id = chore_submissions.member_id));
drop policy if exists chore_submissions_assignment_guard_update on public.chore_submissions;
-- [FIX 4] USING was `true`, which blanket-policy-check.sql (A-16) reports as a policy permitting every row.
create policy chore_submissions_assignment_guard_update on public.chore_submissions as restrictive for update to authenticated
  using (public.can_manage_family(family_id) or exists (
    select 1 from public.chore_assignments a where a.id = assignment_id and a.family_id = chore_submissions.family_id and a.member_id = chore_submissions.member_id))
  with check (public.can_manage_family(family_id) or exists (
    select 1 from public.chore_assignments a where a.id = assignment_id and a.family_id = chore_submissions.family_id and a.member_id = chore_submissions.member_id));
-- 2) a non-manager may delete only an undecided (pending) submission of their own (cleanupSubmission)
drop policy if exists chore_submissions_pending_delete_guard on public.chore_submissions;
create policy chore_submissions_pending_delete_guard on public.chore_submissions as restrictive for delete to authenticated
  using (public.can_manage_family(family_id) or status = 'pending');
-- 3) a non-manager's only update is rejected/needs_improvement -> disputed, with nothing else changed
create or replace function public.chore_submission_member_update_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user = 'service_role' or coalesce(auth.role(), '') = 'service_role' or auth.uid() is null
     or public.can_manage_family(old.family_id) then
    return new;
  end if;
  if (new.family_id, new.assignment_id, new.chore_id, new.member_id, new.kind, new.media_paths, new.note, new.created_by)
       is distinct from (old.family_id, old.assignment_id, old.chore_id, old.member_id, old.kind, old.media_paths, old.note, old.created_by) then
    raise exception 'a submitted proof can only be changed by a family manager' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status in ('rejected','needs_improvement') and new.status = 'disputed') then
    raise exception 'chore submission status % -> % may only be set by a family manager', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_chore_submission_member_update_guard on public.chore_submissions;
create trigger trg_chore_submission_member_update_guard before update on public.chore_submissions
  for each row execute function public.chore_submission_member_update_guard();

-- family_announcements (medium)
do $$
begin
  if to_regclass('public.family_announcements') is null then return; end if;
  alter table public.family_announcements enable row level security;
  drop policy if exists "Members can manage announcements" on public.family_announcements;
  drop policy if exists family_announcements_select on public.family_announcements;
  drop policy if exists family_announcements_insert on public.family_announcements;
  drop policy if exists family_announcements_update on public.family_announcements;
  drop policy if exists family_announcements_delete on public.family_announcements;
  create policy family_announcements_select on public.family_announcements
    for select to authenticated using (public.is_family_member(family_id));
  -- posting is a manager's (UI: parent-only; use is_family_admin to match it exactly), signed as yourself
  create policy family_announcements_insert on public.family_announcements
    for insert to authenticated
    with check (public.can_manage_family(family_id)
                and (author_id is null or author_id = auth.uid())
                and (author_member_id is null or public.is_self_member(author_member_id)));
  create policy family_announcements_update on public.family_announcements
    for update to authenticated
    using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));
  create policy family_announcements_delete on public.family_announcements
    for delete to authenticated using (public.can_manage_family(family_id));
end $$;
revoke insert, update, delete, truncate on public.family_announcements from anon;

-- family_dates (medium)
do $$
begin
  if to_regclass('public.family_dates') is null then return; end if;
  alter table public.family_dates enable row level security;
  drop policy if exists "Members can manage family_dates" on public.family_dates;
  drop policy if exists family_dates_select on public.family_dates;
  drop policy if exists family_dates_insert on public.family_dates;
  drop policy if exists family_dates_update on public.family_dates;
  drop policy if exists family_dates_delete on public.family_dates;
  create policy family_dates_select on public.family_dates
    for select to authenticated using (public.is_family_member(family_id));
  create policy family_dates_insert on public.family_dates
    for insert to authenticated
    with check (public.can_manage_family(family_id) and (created_by is null or created_by = auth.uid()));
  create policy family_dates_update on public.family_dates
    for update to authenticated
    using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));
  create policy family_dates_delete on public.family_dates
    for delete to authenticated using (public.can_manage_family(family_id));
end $$;
revoke insert, update, delete, truncate on public.family_dates from anon;

-- expense_splits (medium)
do $$
begin
  if to_regclass('public.expense_splits') is null then return; end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is missing';
  end if;
  alter table public.expense_splits enable row level security;
  drop policy if exists "Members manage expense_splits" on public.expense_splits;
  drop policy if exists expense_splits_select on public.expense_splits;
  drop policy if exists expense_splits_insert on public.expense_splits;
  drop policy if exists expense_splits_update on public.expense_splits;
  drop policy if exists expense_splits_delete on public.expense_splits;
  create policy expense_splits_select on public.expense_splits
    for select to authenticated
    using (public.is_family_member(family_id)
           and public.family_role(family_id) is distinct from 'guest'::public.member_role);
  create policy expense_splits_insert on public.expense_splits
    for insert to authenticated
    with check (public.is_family_member(family_id) and (created_by is null or created_by = auth.uid()));
  create policy expense_splits_update on public.expense_splits
    for update to authenticated
    using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
  create policy expense_splits_delete on public.expense_splits
    for delete to authenticated using (public.is_family_member(family_id));
  -- a guest looks and does not write (0464's guard, raises 42501)
  drop trigger if exists trg_expense_splits_not_a_guests on public.expense_splits;
  create trigger trg_expense_splits_not_a_guests before insert or update or delete on public.expense_splits
    for each row execute function public.household_write_is_not_a_guests();
end $$;
revoke insert, update, delete, truncate on public.expense_splits from anon;

-- family_polls (+ family_poll_votes) (medium)
-- a guest views the poll; it does not run it (extends 0464's guard to group voting)
do $$
declare t text;
begin
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is required';
  end if;
  foreach t in array array['family_polls','family_poll_options','family_poll_votes'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_not_a_guests', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function public.household_write_is_not_a_guests()',
                   'trg_' || t || '_not_a_guests', t);
  end loop;
end
$$;

-- health_visits (medium)
do $$
declare pol record;
begin
  if to_regclass('public.health_visits') is null then return; end if;
  alter table public.health_visits enable row level security;
  drop policy if exists health_visits_read on public.health_visits;
  -- [FIX 6] guest and caregiver read only their own rows / entries they wrote; parent, adult, teen and child keep
  -- the family-wide read. 0414 records "every family member sees the family's health hub" (owner decision M23)
  -- and health-record-boundary-check.sql pins a CHILD reading the family's visits and vaccinations, so the
  -- child/teen half of this finding needs M23 decided and that probe changed.
  create policy health_visits_read on public.health_visits
    for select to authenticated
    using (
      public.is_family_member(family_id)
      and (public.can_manage_family(family_id)
           or public.is_self_member(member_id)
           or created_by = auth.uid()
           or public.family_role(family_id) not in ('guest','caregiver'))
    );
  -- sweep any other permissive SELECT/ALL policy that would OR the family-wide read back in
  for pol in
    select p.polname from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'health_visits'
      and p.polpermissive and p.polcmd in ('r','*')
      and p.polname <> 'health_visits_read'
  loop
    execute format('drop policy if exists %I on public.health_visits', pol.polname);
  end loop;
end $$;

-- immunizations (medium)
do $$
declare pol record;
begin
  if to_regclass('public.immunizations') is null then return; end if;
  alter table public.immunizations enable row level security;
  drop policy if exists immunizations_read on public.immunizations;
  -- [FIX 6] guest and caregiver read only their own rows / entries they wrote; parent, adult, teen and child keep
  -- the family-wide read. 0414 records "every family member sees the family's health hub" (owner decision M23)
  -- and health-record-boundary-check.sql pins a CHILD reading the family's visits and vaccinations, so the
  -- child/teen half of this finding needs M23 decided and that probe changed.
  create policy immunizations_read on public.immunizations
    for select to authenticated
    using (
      public.is_family_member(family_id)
      and (public.can_manage_family(family_id)
           or public.is_self_member(member_id)
           or created_by = auth.uid()
           or public.family_role(family_id) not in ('guest','caregiver'))
    );
  for pol in
    select p.polname from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'immunizations'
      and p.polpermissive and p.polcmd in ('r','*')
      and p.polname <> 'immunizations_read'
  loop
    execute format('drop policy if exists %I on public.immunizations', pol.polname);
  end loop;
end $$;

-- kid_progress (medium)
-- kid_progress writes are a manager's or the service role's, including writes made inside SECURITY DEFINER RPCs.
-- A guard trigger runs for definer writes too: auth.uid() still carries the caller's JWT.
create or replace function public.kid_progress_write_is_a_managers()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or coalesce(auth.role(), '') = 'service_role' then
    return case when tg_op = 'DELETE' then old else new end; -- service role / jobs / seeds
  end if;
  if (tg_op <> 'INSERT' and not public.can_manage_family(old.family_id))
     or (tg_op <> 'DELETE' and not public.can_manage_family(new.family_id)) then
    raise exception 'Only a parent or guardian can change chore progress' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists trg_kid_progress_manager_write on public.kid_progress;
-- [FIX 5] INSERT OR UPDATE only. As BEFORE ... OR DELETE it fired on the ON DELETE CASCADE from
-- families/family_members, where can_manage_family() is already false for the deleting parent, so deleting
-- a family raised 42501 (checkout-rewards-babysitter-check.sql). Member DELETE stays refused by the
-- restrictive kid_progress_manager_delete_guard below; RI cascades do not consult RLS, and no RPC deletes.
create trigger trg_kid_progress_manager_write
  before insert or update on public.kid_progress
  for each row execute function public.kid_progress_write_is_a_managers();

-- Defence in depth on the policy side: restrictive guards so a later permissive policy cannot reopen member writes.
drop policy if exists kid_progress_manager_insert_guard on public.kid_progress;
create policy kid_progress_manager_insert_guard on public.kid_progress as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id));
drop policy if exists kid_progress_manager_update_guard on public.kid_progress;
create policy kid_progress_manager_update_guard on public.kid_progress as restrictive for update to authenticated
  using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
drop policy if exists kid_progress_manager_delete_guard on public.kid_progress;
create policy kid_progress_manager_delete_guard on public.kid_progress as restrictive for delete to authenticated
  using (public.can_manage_family(family_id));
-- (Optionally also change the guard inside both 0341 RPCs from is_family_member(p_family_id) to can_manage_family(p_family_id), so they return 'forbidden' instead of raising.)

-- meal_vote_options (medium)
do $$
declare p record;
begin
  if to_regclass('public.meal_vote_options') is null then return; end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='meal_vote_options' and permissive='PERMISSIVE' loop
    execute format('drop policy %I on public.meal_vote_options', p.policyname);
  end loop;
  execute 'create policy meal_vote_options_select on public.meal_vote_options for select to authenticated using (public.is_family_member(family_id))';
  -- options are written by the vote's creator (createMealVote) or a manager, never by a guest
  execute 'create policy meal_vote_options_insert on public.meal_vote_options for insert to authenticated with check (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'' and exists (select 1 from public.meal_votes v where v.id = vote_id and v.family_id = meal_vote_options.family_id and (v.created_by = auth.uid() or public.can_manage_family(v.family_id))))';
  execute 'create policy meal_vote_options_update on public.meal_vote_options for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))';
  execute 'create policy meal_vote_options_delete on public.meal_vote_options for delete to authenticated using (public.can_manage_family(family_id) or exists (select 1 from public.meal_votes v where v.id = vote_id and v.created_by = auth.uid()))';
end $$;

-- meal_votes (medium)
do $$
declare p record;
begin
  if to_regclass('public.meal_votes') is null then return; end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='meal_votes' and permissive='PERMISSIVE' loop
    execute format('drop policy %I on public.meal_votes', p.policyname);
  end loop;
  execute 'create policy meal_votes_select on public.meal_votes for select to authenticated using (public.is_family_member(family_id))';
  execute 'create policy meal_votes_insert on public.meal_votes for insert to authenticated with check (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'' and created_by = auth.uid())';
  -- close/reopen stays open to every non-guest member, as the app offers it
  execute 'create policy meal_votes_update on public.meal_votes for update to authenticated using (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'') with check (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'')';
  -- delete: the creator withdrawing their own vote, or a manager
  execute 'create policy meal_votes_delete on public.meal_votes for delete to authenticated using (public.is_family_member(family_id) and (created_by = auth.uid() or public.can_manage_family(family_id)))';
end $$;

-- pet_care_records (medium)
-- reuse 0464's guard (raises 42501 for a guest, service role exempt)
do $$
begin
  if to_regclass('public.pet_care_records') is null then return; end if;
  drop trigger if exists trg_pet_care_records_not_a_guests on public.pet_care_records;
  create trigger trg_pet_care_records_not_a_guests
    before insert or update or delete on public.pet_care_records
    for each row execute function public.household_write_is_not_a_guests();
end $$;
-- optional, if the owner adopts the trust-engine rule that only managers delete:
-- drop policy if exists "Members manage pet_care_records" on public.pet_care_records;
-- drop policy if exists pet_care_records_select on public.pet_care_records; ... (per-command, as 0378)
-- create policy pet_care_records_delete on public.pet_care_records for delete to authenticated using (public.can_manage_family(family_id));

-- pets (medium)
do $$
begin
  if to_regclass('public.pets') is null then return; end if;
  drop trigger if exists trg_pets_not_a_guests on public.pets;
  create trigger trg_pets_not_a_guests
    before insert or update or delete on public.pets
    for each row execute function public.household_write_is_not_a_guests();
end $$;
-- optional (owner decision, ROLE-SCOPE-001): hard delete is never used by the app (it archives), so
-- drop policy if exists "Members manage pets" on public.pets;
-- create policy pets_select on public.pets for select to authenticated using (public.is_family_member(family_id));
-- create policy pets_insert on public.pets for insert to authenticated with check (public.is_family_member(family_id));
-- create policy pets_update on public.pets for update to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
-- create policy pets_delete on public.pets for delete to authenticated using (public.can_manage_family(family_id));

-- member_locations (medium)
-- Owner decision (ROLE-SCOPE-001): a guest sees only their own row.
-- Replaces the permissive SELECT in place, as 0378 does; 0335's restrictive write guards are untouched.
do $$
begin
  if to_regclass('public.member_locations') is null then return; end if;
  drop policy if exists member_locations_select on public.member_locations;
  create policy member_locations_select on public.member_locations
    for select to authenticated
    using (
      public.is_family_member(family_id)
      and (public.is_self_member(member_id)
           or public.family_role(family_id) is distinct from 'guest'::public.member_role)
    );
end $$;
-- (extend the predicate to 'caregiver' as well if the owner rules caregivers see only assigned members)

-- reward_redemptions (medium)
-- A member asks for a catalogue reward at its price; only a manager decides.
create or replace function public.reward_redemption_request_shape_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare r record;
begin
  if current_user = 'service_role' or coalesce(auth.role(),'') = 'service_role'
     or auth.uid() is null or public.can_manage_family(new.family_id) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.reward_id is null then
      raise exception 'a redemption must name a reward' using errcode = '42501';
    end if;
    select title, cost_points into r from public.rewards
     where id = new.reward_id and family_id = new.family_id;
    if not found or new.reward_title is distinct from r.title
       or new.cost_points is distinct from r.cost_points then
      raise exception 'a redemption carries its reward''s own title and price' using errcode = '42501';
    end if;
    if new.decided_by is not null or new.decided_at is not null then
      raise exception 'a request may not carry a decision' using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE by a non-manager: withdrawing is the only move (status, plus the updated_at stamp).
  if new.family_id is distinct from old.family_id or new.member_id is distinct from old.member_id
     or new.reward_id is distinct from old.reward_id or new.reward_title is distinct from old.reward_title
     or new.cost_points is distinct from old.cost_points or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at or new.note is distinct from old.note
     or new.created_at is distinct from old.created_at then
    raise exception 'a member may only withdraw their own request' using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function public.reward_redemption_request_shape_guard() from public, anon, authenticated;
drop trigger if exists trg_reward_redemption_request_shape_guard on public.reward_redemptions;
create trigger trg_reward_redemption_request_shape_guard
  before insert or update on public.reward_redemptions
  for each row execute function public.reward_redemption_request_shape_guard();

-- wishlist_items (medium)
-- wishlist_items: a wish is its owner's (or a manager's) to write. Claims are first-person.
do $$
begin
  if to_regclass('public.wishlist_items') is null then return; end if;
  execute 'drop policy if exists "Members can manage wishlist_items" on public.wishlist_items';
  execute 'drop policy if exists wishlist_items_select on public.wishlist_items';
  execute 'drop policy if exists wishlist_items_insert on public.wishlist_items';
  execute 'drop policy if exists wishlist_items_update on public.wishlist_items';
  execute 'drop policy if exists wishlist_items_delete on public.wishlist_items';
  execute 'create policy wishlist_items_select on public.wishlist_items for select to authenticated using (public.is_family_member(family_id))';
  execute 'create policy wishlist_items_insert on public.wishlist_items for insert to authenticated with check ('
       || 'public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id)) '
       || 'and claimed_by is null and claimed_at is null and is_purchased = false)';
  -- UPDATE stays open to members so a non-owner can claim. The trigger below decides which columns each caller may change.
  execute 'create policy wishlist_items_update on public.wishlist_items for update to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'create policy wishlist_items_delete on public.wishlist_items for delete to authenticated using ('
       || 'public.is_family_member(family_id) and (public.is_self_member(member_id) or public.can_manage_family(family_id)))';
end
$$;

create or replace function public.wishlist_item_write_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  content_changed boolean;
  claim_changed boolean;
begin
  if auth.uid() is null or coalesce(auth.role(), '') = 'service_role' then return new; end if;
  -- [FIX 7] an ON DELETE SET NULL from family_members (claimed_by) or auth.users (created_by) arrives here
  -- as an UPDATE fired from the RI trigger; removing a member who had claimed a gift must not raise.
  if pg_trigger_depth() > 1 then return new; end if;
  content_changed := new.family_id is distinct from old.family_id or new.member_id is distinct from old.member_id
    or new.title is distinct from old.title or new.url is distinct from old.url or new.price is distinct from old.price
    or new.priority is distinct from old.priority or new.notes is distinct from old.notes or new.created_by is distinct from old.created_by;
  claim_changed := new.claimed_by is distinct from old.claimed_by or new.claimed_at is distinct from old.claimed_at
    or new.is_purchased is distinct from old.is_purchased;
  if content_changed and not (public.is_self_member(old.member_id) or public.can_manage_family(old.family_id)) then
    raise exception 'only the wish''s owner can change it' using errcode = '42501';
  end if;
  if claim_changed then
    if public.is_self_member(old.member_id) then
      raise exception 'you cannot claim your own wish' using errcode = '42501';
    end if;
    if old.claimed_by is not null and not public.is_self_member(old.claimed_by) then
      raise exception 'this gift is claimed by someone else' using errcode = '42501';
    end if;
    if new.claimed_by is not null and not public.is_self_member(new.claimed_by) then
      raise exception 'a claim is made for yourself' using errcode = '42501';
    end if;
    if new.is_purchased and new.claimed_by is null then
      raise exception 'claim the gift before marking it bought' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_wishlist_item_write_guard on public.wishlist_items;
create trigger trg_wishlist_item_write_guard before update on public.wishlist_items
  for each row execute function public.wishlist_item_write_guard();

-- Owner-side surprise: RLS cannot hide columns per row. Revoke direct SELECT on the claim columns and
-- serve them through a security-definer view or RPC that nulls them when is_self_member(member_id), e.g.
-- revoke select (claimed_by, claimed_at, is_purchased) on public.wishlist_items from authenticated;
-- (apply only together with the view/RPC change in wishlists-module.tsx, which currently selects '*').

-- trip_memories (medium)
-- trip_memories: members read. Non-guests add their own entries. The author or a manager edits or deletes.
do $$
begin
  if to_regclass('public.trip_memories') is null then return; end if;
  execute 'drop policy if exists "Members manage trip_memories" on public.trip_memories';
  execute 'drop policy if exists trip_memories_select on public.trip_memories';
  execute 'drop policy if exists trip_memories_insert on public.trip_memories';
  execute 'drop policy if exists trip_memories_update on public.trip_memories';
  execute 'drop policy if exists trip_memories_delete on public.trip_memories';
  execute 'create policy trip_memories_select on public.trip_memories for select to authenticated using (public.is_family_member(family_id))';
  execute 'create policy trip_memories_insert on public.trip_memories for insert to authenticated with check ('
       || 'public.is_family_member(family_id) and public.family_role(family_id) <> ''guest'' and created_by = auth.uid())';
  execute 'create policy trip_memories_update on public.trip_memories for update to authenticated '
       || 'using (public.can_manage_family(family_id) or (created_by = auth.uid() and public.family_role(family_id) in (''teen'',''caregiver''))) '
       || 'with check (public.can_manage_family(family_id) or (created_by = auth.uid() and public.family_role(family_id) in (''teen'',''caregiver'')))';
  execute 'create policy trip_memories_delete on public.trip_memories for delete to authenticated using (public.can_manage_family(family_id))';
end
$$;
-- trip-memories-module.tsx: show the delete button only when isManager(role), so the screen matches.

-- care_log (low)
-- care_log: care notes (medication, incidents) are not a guest's to read; every other member keeps the family-wide read
drop policy if exists care_log_not_a_guests_read on public.care_log;
create policy care_log_not_a_guests_read on public.care_log
  as restrictive for select to authenticated
  using (public.family_role(family_id) is distinct from 'guest');

-- child_logins (low)
-- child_logins: a login handle is visible to the child it belongs to and to managers
-- [FIX 8] NOT applied. child-login-mapping-is-managers-only-check.sql records "a child CAN still read:
-- a username is a handle the family shares and the kid surface displays it" as a decision and fails
-- if it changes. Owner decision + probe change required:
-- drop policy if exists "Members can view child_logins" on public.child_logins;
-- create policy "Members can view child_logins" on public.child_logins
--   for select to authenticated
--   using (
--     public.is_family_member(family_id)
--     and (public.can_manage_family(family_id) or public.is_self_member(member_id))
--   );

-- dining_out (low)
do $$
declare p record;
begin
  if to_regclass('public.dining_out') is null then return; end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='dining_out' and permissive='PERMISSIVE' loop
    execute format('drop policy %I on public.dining_out', p.policyname);
  end loop;
  create policy dining_out_select on public.dining_out for select to authenticated using (public.is_family_member(family_id));
  create policy dining_out_insert on public.dining_out for insert to authenticated
    with check (public.is_family_member(family_id) and public.family_role(family_id) is distinct from 'guest'
      and (created_by = auth.uid() or public.can_manage_family(family_id)));
  -- any non-guest member may heart a place (toggleFavoriteAction); editing the row otherwise is its creator's or a manager's
  create policy dining_out_update on public.dining_out for update to authenticated
    using (public.is_family_member(family_id) and public.family_role(family_id) is distinct from 'guest')
    with check (public.is_family_member(family_id) and public.family_role(family_id) is distinct from 'guest');
  create policy dining_out_delete on public.dining_out for delete to authenticated
    using (public.can_manage_family(family_id) or (public.is_family_member(family_id) and created_by = auth.uid() and public.family_role(family_id) is distinct from 'guest'));
end $$;
-- non-creator, non-manager updates may change only is_favorite
create or replace function public.dining_out_member_update_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null or coalesce(auth.role(),'') = 'service_role' or public.can_manage_family(old.family_id) or old.created_by = auth.uid() then return new; end if;
  if (to_jsonb(new) - 'is_favorite' - 'updated_at') is distinct from (to_jsonb(old) - 'is_favorite' - 'updated_at') then
    raise exception 'only the person who logged this, or a parent, can edit it' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_dining_out_member_update_guard on public.dining_out;
create trigger trg_dining_out_member_update_guard before update on public.dining_out for each row execute function public.dining_out_member_update_guard();
revoke insert, update, delete, truncate on public.dining_out from anon;

-- dashboard_layout_events (low)
do $$
declare p record;
begin
  if to_regclass('public.dashboard_layout_events') is null then return; end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='dashboard_layout_events' and permissive='PERMISSIVE' loop
    execute format('drop policy %I on public.dashboard_layout_events', p.policyname);
  end loop;
  create policy dashboard_layout_events_select on public.dashboard_layout_events for select to authenticated
    using (public.is_family_member(family_id));
  -- append-only, first-person: the caller logs their own event
  create policy dashboard_layout_events_insert on public.dashboard_layout_events for insert to authenticated
    with check (public.is_family_member(family_id) and user_id = auth.uid());
  -- no member UPDATE; only a manager may prune history
  create policy dashboard_layout_events_delete on public.dashboard_layout_events for delete to authenticated
    using (public.can_manage_family(family_id));
end $$;
revoke insert, update, delete, truncate on public.dashboard_layout_events from anon;

-- family_food_scores (low)
do $$
begin
  if to_regclass('public.family_food_scores') is null then return; end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is missing';
  end if;
  alter table public.family_food_scores enable row level security;
  drop policy if exists "Members can manage family_food_scores" on public.family_food_scores;
  drop policy if exists family_food_scores_select on public.family_food_scores;
  drop policy if exists family_food_scores_insert on public.family_food_scores;
  drop policy if exists family_food_scores_update on public.family_food_scores;
  drop policy if exists family_food_scores_delete on public.family_food_scores;
  create policy family_food_scores_select on public.family_food_scores
    for select to authenticated using (public.is_family_member(family_id));
  create policy family_food_scores_insert on public.family_food_scores
    for insert to authenticated
    with check (public.is_family_member(family_id)
                and (created_by is null or created_by = auth.uid())
                and (updated_by is null or updated_by = auth.uid()));
  create policy family_food_scores_update on public.family_food_scores
    for update to authenticated
    using (public.is_family_member(family_id))
    with check (public.is_family_member(family_id) and (updated_by is null or updated_by = auth.uid()));
  create policy family_food_scores_delete on public.family_food_scores
    for delete to authenticated using (public.can_manage_family(family_id));
  drop trigger if exists trg_family_food_scores_not_a_guests on public.family_food_scores;
  create trigger trg_family_food_scores_not_a_guests before insert or update or delete on public.family_food_scores
    for each row execute function public.household_write_is_not_a_guests();
end $$;
revoke insert, update, delete, truncate on public.family_food_scores from anon;

-- family_poll_options (low)
do $$
begin
  if to_regclass('public.family_poll_options') is null then return; end if;
  execute 'drop policy if exists "Members manage family_poll_options" on public.family_poll_options';
  execute 'drop policy if exists family_poll_options_select on public.family_poll_options';
  execute 'drop policy if exists family_poll_options_insert on public.family_poll_options';
  execute 'drop policy if exists family_poll_options_update on public.family_poll_options';
  execute 'drop policy if exists family_poll_options_delete on public.family_poll_options';
  execute 'create policy family_poll_options_select on public.family_poll_options for select to authenticated using (public.is_family_member(family_id))';
  -- options belong to the poll's author (or a manager) and to the poll's own family
  execute $p$create policy family_poll_options_insert on public.family_poll_options for insert to authenticated
    with check (public.is_family_member(family_id) and exists (select 1 from public.family_polls p
      where p.id = poll_id and p.family_id = family_poll_options.family_id
        and (p.created_by = auth.uid() or public.can_manage_family(p.family_id))))$p$;
  execute $p$create policy family_poll_options_update on public.family_poll_options for update to authenticated
    using (public.is_family_member(family_id) and exists (select 1 from public.family_polls p
      where p.id = poll_id and p.family_id = family_poll_options.family_id
        and (p.created_by = auth.uid() or public.can_manage_family(p.family_id))))
    with check (public.is_family_member(family_id) and exists (select 1 from public.family_polls p
      where p.id = poll_id and p.family_id = family_poll_options.family_id
        and (p.created_by = auth.uid() or public.can_manage_family(p.family_id))))$p$;
  execute $p$create policy family_poll_options_delete on public.family_poll_options for delete to authenticated
    using (public.is_family_member(family_id) and exists (select 1 from public.family_polls p
      where p.id = poll_id and p.family_id = family_poll_options.family_id
        and (p.created_by = auth.uid() or public.can_manage_family(p.family_id))))$p$;
end
$$;

-- family_onboarding (low)
do $$
begin
  if to_regclass('public.family_onboarding') is null then return; end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is required';
  end if;
  drop trigger if exists trg_family_onboarding_not_a_guests on public.family_onboarding;
  create trigger trg_family_onboarding_not_a_guests
    before insert or update or delete on public.family_onboarding
    for each row execute function public.household_write_is_not_a_guests();
end
$$;

-- family_places (low)
do $$
begin
  if to_regclass('public.family_places') is null then return; end if;
  execute 'drop policy if exists family_places_select on public.family_places';
  execute $p$create policy family_places_select on public.family_places for select to authenticated
    using (public.is_family_member(family_id) and public.family_role(family_id) is distinct from 'guest')$p$;
  -- insert/update/delete stay as 0215 wrote them (can_manage_family)
end
$$;

-- homework_assignments (low)
-- Reuse 0464's guard (raises 42501 for a caller whose role in the row's family is guest; service role exempt).
do $$
begin
  if to_regclass('public.homework_assignments') is null then return; end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is missing';
  end if;
  drop trigger if exists trg_homework_assignments_not_a_guests on public.homework_assignments;
  create trigger trg_homework_assignments_not_a_guests
    before insert or update or delete on public.homework_assignments
    for each row execute function public.household_write_is_not_a_guests();
end $$;

-- leftover_inventory (low)
-- Reuse 0464's guard: a guest sees the household but does not change it.
do $$
begin
  if to_regclass('public.leftover_inventory') is not null
     and to_regprocedure('public.household_write_is_not_a_guests()') is not null then
    execute 'drop trigger if exists trg_leftover_inventory_not_a_guests on public.leftover_inventory';
    execute 'create trigger trg_leftover_inventory_not_a_guests before insert or update or delete on public.leftover_inventory '
            'for each row execute function public.household_write_is_not_a_guests()';
  end if;
end $$;

-- library_feeds (low)
do $$
begin
  if to_regclass('public.library_feeds') is not null
     and to_regprocedure('public.household_write_is_not_a_guests()') is not null then
    execute 'drop trigger if exists trg_library_feeds_not_a_guests on public.library_feeds';
    execute 'create trigger trg_library_feeds_not_a_guests before insert or update or delete on public.library_feeds '
            'for each row execute function public.household_write_is_not_a_guests()';
  end if;
end $$;

-- library_items (low)
do $$
begin
  if to_regclass('public.library_items') is not null
     and to_regprocedure('public.household_write_is_not_a_guests()') is not null then
    execute 'drop trigger if exists trg_library_items_not_a_guests on public.library_items';
    execute 'create trigger trg_library_items_not_a_guests before insert or update or delete on public.library_items '
            'for each row execute function public.household_write_is_not_a_guests()';
  end if;
end $$;

-- meal_nutrition (low)
do $$
declare p record;
begin
  if to_regclass('public.meal_nutrition') is null then return; end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='meal_nutrition' and permissive='PERMISSIVE' loop
    execute format('drop policy %I on public.meal_nutrition', p.policyname);
  end loop;
  execute 'create policy meal_nutrition_select on public.meal_nutrition for select to authenticated using (public.is_family_member(family_id))';
  -- the nutrition route upserts on the caller''s session: keep non-guest members, pin authorship
  execute 'create policy meal_nutrition_insert on public.meal_nutrition for insert to authenticated with check (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'' and created_by = auth.uid())';
  execute 'create policy meal_nutrition_update on public.meal_nutrition for update to authenticated using (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'') with check (created_by = auth.uid() and (public.is_family_member(family_id) and coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest''))';
  -- [FIX 9] meal_nutrition_update WITH CHECK reordered to `created_by = auth.uid() and (<USING>)`, same meaning,
  -- so it textually contains the USING (marketplace-deal-terms-check.sql's asymmetric-UPDATE sweep).
  execute 'create policy meal_nutrition_delete on public.meal_nutrition for delete to authenticated using (public.can_manage_family(family_id))';
end $$;
-- Full integrity (no hand-written numbers) needs the route to write with the service role and member writes dropped entirely.

-- meal_vote_ballots (low)
do $$
begin
  if to_regclass('public.meal_vote_ballots') is null then return; end if;
  execute 'drop policy if exists meal_vote_ballots_not_a_guest on public.meal_vote_ballots';
  execute 'create policy meal_vote_ballots_not_a_guest on public.meal_vote_ballots as restrictive for insert to authenticated with check (coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'' and exists (select 1 from public.meal_vote_options o where o.id = option_id and o.vote_id = meal_vote_ballots.vote_id and o.family_id = meal_vote_ballots.family_id))';
  execute 'drop policy if exists meal_vote_ballots_not_a_guest_update on public.meal_vote_ballots';
  execute 'create policy meal_vote_ballots_not_a_guest_update on public.meal_vote_ballots as restrictive for update to authenticated using (coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'') with check (coalesce(public.family_role(family_id)::text, ''guest'') <> ''guest'')';
end $$;

-- pantry_items (low)
do $$
begin
  if to_regclass('public.pantry_items') is null then return; end if;
  drop trigger if exists trg_pantry_items_not_a_guests on public.pantry_items;
  create trigger trg_pantry_items_not_a_guests
    before insert or update or delete on public.pantry_items
    for each row execute function public.household_write_is_not_a_guests();
end $$;

-- renewals (low)
-- Guests see shared events, not the household's ID/licence/insurance expiry register.
drop policy if exists renewals_not_a_guests_read on public.renewals;
create policy renewals_not_a_guests_read on public.renewals
  as restrictive for select to authenticated
  using (public.family_role(family_id) is distinct from 'guest');

-- subscriptions_tracked (low)
-- Guests do not read the household's recurring charges.
drop policy if exists subscriptions_tracked_not_a_guests_read on public.subscriptions_tracked;
create policy subscriptions_tracked_not_a_guests_read on public.subscriptions_tracked
  as restrictive for select to authenticated
  using (public.family_role(family_id) is distinct from 'guest');

-- screen_time_entries (low)
-- A guest views screen time; it does not log it (0464's rule, same trigger function).
do $$
begin
  if to_regclass('public.screen_time_entries') is null then return; end if;
  drop trigger if exists trg_screen_time_entries_not_a_guests on public.screen_time_entries;
  create trigger trg_screen_time_entries_not_a_guests
    before insert or update or delete on public.screen_time_entries
    for each row execute function public.household_write_is_not_a_guests();
end $$;
