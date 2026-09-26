-- Bubaly :: 0326 - a chore dispute may be RAISED by anyone and RESOLVED by a
--                  manager (the fourth sibling of 0222, 0223 and 0295)
--
-- `chore_disputes` (00430_chore_missions.sql) carries one policy:
--
--   chore_disputes_all  FOR ALL TO authenticated
--     USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))
--
-- A blanket manager guard on this table would be WRONG, and that is the whole
-- point of doing it with a trigger instead. Raising a dispute is the feature:
-- `disputeSubmissionAction` (app/(app)/missions/actions.ts) has no role gate at
-- all — a child who thinks the AI marked their chore unfairly says so, and the
-- row is what puts it in front of a parent. Its two rollback paths delete the
-- row they just inserted, on the same un-gated client, so DELETE has to stay
-- open too.
--
-- The manager rule is on RESOLUTION, and it lives inside one function:
--
--   export async function approveSubmissionAction(formData: FormData) {
--     …
--     if (!isManager(ctx.active.role)) return;
--     …
--     await supabase.from('chore_disputes').update({
--       status: 'resolved', resolution: 'Approved by parent',
--       resolved_by: ctx.active.member.id, resolved_at: … })
--       .eq('submission_id', submissionId).eq('status', 'open')
--
-- Nothing else in the codebase ever sets `status='resolved'`, `resolution`,
-- `resolved_by` or `resolved_at` — and the only code that clears them again is
-- the same manager-gated action rolling its own approval back.
--
-- So the shape of the defect is the shape 0222 found on `chore_submissions`,
-- 0223 on `chore_assignments` and 0295 on `reward_redemptions`: a decision
-- column on a table whose rows members are supposed to create. Measured on a
-- replayed database acting as a child of the family:
--
--   update chore_disputes set status='resolved', resolution='Approved by parent',
--          resolved_by=<my member id>, resolved_at=now()          -> UPDATE 1
--
-- and app/(app)/missions/page.tsx reads disputes with `.eq('status','open')`,
-- so the row the child filed — and then marked settled in a parent's name —
-- simply stops appearing on the parent's screen, over a chore submission the
-- child disputed. It mints nothing: the reward is paid by `finalizeApproval`,
-- which only `approveSubmissionAction` reaches and which is manager-gated
-- behind the same `isManager` return, and `chore_submissions.status` has been
-- guarded since 0222. What is forged is the record of a parent's decision.
--
-- Guarded statuses: 'resolved' — the one a parent decides.
-- Member-allowed: 'open' (raising) and 'cancelled' (withdrawing your own ask,
-- which needs no parent), exactly as 0295 drew the same line.
-- Guarded columns: `resolution`, `resolved_by`, `resolved_at` — writing them
-- OR clearing them, because the rollback that clears them is a manager's too,
-- and a row left `status='open'` while still carrying a fabricated
-- `resolved_by` would be a forgery with better manners.
--
-- The trusted server is allowed through on the same terms 0222/0295 use: the
-- service role, and a migration or seed running with no authenticated session.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

do $$
begin
  if to_regclass('public.chore_disputes') is null then
    return;
  end if;

  create or replace function public.chore_dispute_resolution_guard()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
  as $fn$
  declare
    touches_decision boolean;
  begin
    if tg_op = 'INSERT' then
      touches_decision :=
        new.status = 'resolved'
        or new.resolution is not null
        or new.resolved_by is not null
        or new.resolved_at is not null;
    else
      touches_decision :=
        (new.status = 'resolved' and new.status is distinct from old.status)
        or new.resolution  is distinct from old.resolution
        or new.resolved_by is distinct from old.resolved_by
        or new.resolved_at is distinct from old.resolved_at;
    end if;

    if not touches_decision then
      return new;
    end if;

    -- Allow the trusted server (service role, or a migration/seed running
    -- without an authenticated session) and family managers (parent/adult).
    -- Block a member settling — or un-settling — their own dispute.
    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null
       or public.can_manage_family(new.family_id) then
      return new;
    end if;

    raise exception
      'a chore dispute may only be resolved by a family manager'
      using errcode = '42501';
  end;
  $fn$;

  comment on function public.chore_dispute_resolution_guard() is
    'Raising a chore dispute is open to every member (disputeSubmissionAction has no role gate, and its rollback deletes the row it just wrote). Resolving one is manager-only, inside approveSubmissionAction. This guards status=resolved and the resolution/resolved_by/resolved_at columns rather than the table, because a blanket policy would take the dispute away from the child it exists for.';

  drop trigger if exists trg_chore_dispute_resolution_guard on public.chore_disputes;
  create trigger trg_chore_dispute_resolution_guard
    before insert or update on public.chore_disputes
    for each row execute function public.chore_dispute_resolution_guard();
end $$;

do $$
begin
  if to_regclass('public.chore_disputes') is null then
    return;
  end if;
  -- A migration that silently created nothing is worse than one that failed.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.chore_disputes'::regclass
      and tgname = 'trg_chore_dispute_resolution_guard'
      and not tgisinternal
  ) then
    raise exception '0326: the chore dispute resolution guard was not created';
  end if;
  raise notice '0326 OK: a chore dispute is raised by any member and resolved only by a manager.';
end $$;
