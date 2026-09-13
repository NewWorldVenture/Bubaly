-- Bubaly :: 0295 - reward redemption decision-status guard
--            (the third sibling of 0222's submission guard and 0223's
--             chore-assignment guard)
--
-- reward_redemptions shipped (0028) with ONE policy — `FOR ALL … USING
-- is_family_member(family_id) WITH CHECK is_family_member(family_id)` — and no
-- trigger. Both of its write paths are DIRECT BROWSER WRITES:
--
--   components/modules/chores-module.tsx  redeem()        insert
--   components/modules/rewards-module.tsx requestReward() insert
--   components/modules/rewards-module.tsx decide()        update
--
-- and each supplies `status` and `decided_by` from the client, choosing
-- 'approved' when the signed-in member is a manager and 'requested' otherwise.
-- The choice was the CLIENT'S. A child calling PostgREST directly could insert
-- a redemption already marked 'approved' with `decided_by` pointing at
-- themselves, or update one sitting in the queue to 'approved' — self-approving
-- a reward no parent ever agreed to.
--
-- Like 0222 and 0223 this mints no money: the points economy is separate from
-- the wallet, which is manager-only under 0217. It is an accountability
-- forgery, and it is the last of the three decision surfaces to be guarded.
--
-- Guarded statuses: approved, rejected, fulfilled — the three a parent decides.
-- Member-allowed: requested, pending (asking), and cancelled (withdrawing your
-- own ask, which needs no parent).
--
-- No legitimate flow breaks. The only code that sets a guarded status is a
-- manager's own click in the two modules above, and the service role.

do $$
begin
  if to_regclass('public.reward_redemptions') is null then
    return;
  end if;

  create or replace function public.reward_redemption_decision_guard()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
  as $fn$
  begin
    -- Only guard transitions INTO a manager-decision status.
    if new.status in ('approved','rejected','fulfilled')
       and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      -- Allow the trusted server (service role, or a migration/seed running
      -- without an authenticated session) and family managers (parent/adult).
      -- Block a plain member self-approving their own reward.
      if current_user = 'service_role'
         or coalesce(auth.role(), '') = 'service_role'
         or auth.uid() is null
         or public.can_manage_family(new.family_id) then
        return new;
      end if;
      raise exception
        'reward redemption status % may only be set by a family manager', new.status
        using errcode = '42501';
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_reward_redemption_decision_guard on public.reward_redemptions;
  create trigger trg_reward_redemption_decision_guard
    before insert or update on public.reward_redemptions
    for each row execute function public.reward_redemption_decision_guard();
end $$;
