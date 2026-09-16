-- Bubaly :: 0304 - economy-redemption and invest-order decision guards
--            (the fourth and fifth siblings of 0222's submission guard,
--             0223's chore-assignment guard and 0295's reward guard)
--
-- 0295 closed reward_redemptions and called itself "the last of the three
-- decision surfaces to be guarded". It was not. Two tables carry the same
-- shape — a `status` defaulting to pending, a `decided_by` and a `decided_at`,
-- and an INSERT policy open to any family member — and neither was guarded:
--
--   public.economy_redemptions   insert policy: is_family_member(family_id)
--   public.invest_orders         insert policy: is_family_member(family_id)
--
-- Their siblings constrain the same insert to the undecided state
-- (`parent_approvals_insert` requires status = 'pending' and decided_by is
-- null; `approval_requests_insert` likewise). These two constrain nothing, so
-- a child calling PostgREST directly can insert a row already marked approved
-- or filled, with `decided_by` pointing at a parent who never saw it.
--
-- Measured on a replayed database with every migration applied, acting as a
-- child of the family: both inserts succeeded, one row each.
--
-- What it costs, stated precisely, because the two differ:
--
--   * economy_redemptions — the debit lives in `economy_decide_redemption`,
--     whose own comment is "Approval debits the ledger". A row inserted
--     already-approved never goes through that function, so the reward is
--     recorded as granted and the tokens are never taken. The points economy
--     is separate from the wallet (0217 keeps that manager-only), so no money
--     is minted — but a reward IS taken for free, with a parent's name on the
--     approval.
--
--   * invest_orders — `invest_decide_order` is what moves the wallet and
--     writes the holding, so a forged 'filled' creates neither. It is an
--     accountability forgery rather than a transfer: the order reads as
--     executed and nothing backs it.
--
-- And in BOTH cases the forgery is not correctable through the product. Each
-- RPC begins by refusing a row it did not find pending —
-- `if v_redemption.status <> 'pending' then return 'already_decided'`, and the
-- same line in invest_decide_order — so a parent who notices cannot approve or
-- reject it. The row is stuck in the state the child chose.
--
-- Guarded statuses are the ones a parent decides. Everything a member
-- legitimately does is untouched: asking (requested, pending) and withdrawing
-- their own ask (cancelled) need no parent and stay open.
--
-- The guard is 0295's, verbatim in structure: the trusted server (service
-- role, or a migration or seed running without an authenticated session) and
-- family managers pass; a plain member setting a decision status is refused
-- with 42501. Written as a trigger rather than a policy predicate for the same
-- reason 0295 was — it must cover the UPDATE transition too, and it must say
-- WHY it refused rather than making a row silently vanish from a WITH CHECK.

do $$
begin
  if to_regclass('public.economy_redemptions') is null
     and to_regclass('public.invest_orders') is null then
    return;
  end if;

  create or replace function public.decision_status_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  declare
    guarded text[] := tg_argv[0]::text[];
  begin
    -- Only guard transitions INTO a manager-decision status.
    if new.status::text = any (guarded)
       and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      -- Allow the trusted server (service role, or a migration/seed running
      -- without an authenticated session) and family managers (parent/adult).
      -- Block a plain member deciding their own request.
      if current_user = 'service_role'
         or coalesce(auth.role(), '') = 'service_role'
         or auth.uid() is null
         or public.can_manage_family(new.family_id) then
        return new;
      end if;
      raise exception
        '% status % may only be set by a family manager', tg_table_name, new.status
        using errcode = '42501';
    end if;
    return new;
  end;
  $guard$;

  comment on function public.decision_status_guard() is
    'Shared decision-status guard for request tables (status + decided_by). The guarded statuses are passed as a trigger argument, so economy_redemptions and invest_orders share one implementation with reward_redemptions'' 0295 behaviour.';
end
$$;

-- ── economy_redemptions ─────────────────────────────────────────────────────
-- Member-allowed: requested, pending (asking) and cancelled (withdrawing).
do $$
begin
  if to_regclass('public.economy_redemptions') is null then
    return;
  end if;
  drop trigger if exists trg_economy_redemption_decision_guard on public.economy_redemptions;
  create trigger trg_economy_redemption_decision_guard
    before insert or update on public.economy_redemptions
    for each row execute function public.decision_status_guard('{approved,rejected,fulfilled}');
end
$$;

-- ── invest_orders ───────────────────────────────────────────────────────────
-- Member-allowed: pending (asking) and cancelled (withdrawing).
do $$
begin
  if to_regclass('public.invest_orders') is null then
    return;
  end if;
  drop trigger if exists trg_invest_order_decision_guard on public.invest_orders;
  create trigger trg_invest_order_decision_guard
    before insert or update on public.invest_orders
    for each row execute function public.decision_status_guard('{filled,rejected}');
end
$$;
