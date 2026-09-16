-- Bubaly :: 0320 - a reward costs what the parent set
-- ----------------------------------------------------------------------------
-- Renumbered from 0304. main landed seven migrations at once — 0304 economy
-- invest decision guard, 0305 chore award amounts, 0306 money instructions,
-- 0307 chore prices, 0308 reward catalogue, 0309 prescriptions, 0310 UI-only
-- manager gates — colliding with this branch's whole 0304-0310 block. The NINTH
-- collision event between the two sessions and by far the largest; every merge
-- since 0300 has brought one. Only the numbers changed: this branch's seven
-- moved together to 0320-0326, keeping their order relative to each other.
--
-- Main's seven are RESTRICTIVE guards (`as restrictive`, 0254's mechanism), so
-- they AND with everything here and nothing in this block can loosen them by
-- running later. The two sets are defence in depth over the same tables rather
-- than one overwriting the other, and the probes are run against the combined
-- chain to say so rather than to assume it.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- The same defect main's 0305 and 0307 close on the chores board, in the
-- economy module. (This branch had its own chores migration for it; main landed
-- first with a narrower, column-scoped rule and this branch's was withdrawn —
-- see the note in tests/chore-price-is-a-managers-to-write.test.ts.)
--
-- `economy_redemptions_insert` constrains ONE column:
--     with check (is_family_member(family_id))
-- Everything else on the row is the caller's to choose — `cost`, `member_id`,
-- `status`, `decided_by`, `decided_at`, `txn_id`, `title`. And
-- `economy_decide_redemption()` debits `v_redemption.cost`: the number on the
-- row the child wrote. It locks the `economy_rewards` row two statements
-- earlier — for STOCK — and never reads the price off it.
--
-- Proven live as a real child session: a 5000-star "PlayStation 5" redeemed for
-- ONE star; a row forged already `status='fulfilled'` with `decided_by` pointing
-- at a parent; and a redemption inserted that bills the PARENT's balance.
--
-- The asymmetry that found it: the sibling table `reward_redemptions` carries
-- `trg_reward_redemption_decision_guard` from 0295. This one carries only
-- `set_updated_at`. Two tables doing the same job, one guarded.
--
-- The server action is NOT the boundary and never was. `requestRedemptionAction`
-- reads cost/title/currency_id off the reward and does the right thing — but the
-- browser holds the anon key and talks to PostgREST directly, so the action is
-- an convenience, not a gate. (It also accepts any `memberId` in the family, so
-- even through the action a child could bill a sibling.)
--
-- TWO CHANGES, because neither should be load-bearing alone.
--
-- 1. A trigger in 0295's idiom. For a non-manager, an inserted redemption must
--    be a REQUEST and nothing more: status 'pending', no decision fields, for
--    their OWN member, naming a real reward, at that reward's price, in that
--    reward's currency. A redemption with no `reward_id` is a free-form debit
--    with a caller-chosen cost — exactly the hole — so it stays a manager's.
--    UPDATE is already manager-only by policy; the trigger covers it too, so a
--    future `drop policy` cannot reopen this by itself.
--
-- 2. `economy_decide_redemption` stops trusting the row. When the redemption
--    names a reward, the price DEBITED is the reward's current cost — the value
--    a manager controls, on a row the function already locks — and it is written
--    back so the record matches what was charged. A free-form redemption (no
--    reward_id, manager-authored by rule 1) keeps its own cost.
--    A parent who reprices a reward while a request is pending therefore charges
--    the price shown on the board, which is the one answer that is never a
--    surprise in either direction.

create or replace function public.economy_redemption_request_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_reward record;
  v_own    uuid;
begin
  -- The trusted server (service role, or a migration/seed with no authenticated
  -- session) and family managers decide; a plain member only asks.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null
     or public.can_manage_family(new.family_id) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'a redemption may only be decided by a family manager'
      using errcode = '42501';
  end if;

  if coalesce(new.status, 'pending') <> 'pending' then
    raise exception 'a redemption may only be requested as pending, not as %', new.status
      using errcode = '42501';
  end if;
  if new.decided_by is not null or new.decided_at is not null or new.txn_id is not null then
    raise exception 'a redemption may not be requested with a decision already recorded'
      using errcode = '42501';
  end if;

  -- Your own member, not a sibling's balance.
  select id into v_own
    from public.family_members
   where family_id = new.family_id and user_id = auth.uid() and is_active
   limit 1;
  if v_own is null or new.member_id is distinct from v_own then
    raise exception 'a redemption may only be requested for your own member'
      using errcode = '42501';
  end if;

  -- A real reward, at its price, in its currency. Without a reward_id this is a
  -- free-form debit whose amount the caller picked.
  if new.reward_id is null then
    raise exception 'a redemption must name a reward'
      using errcode = '42501';
  end if;
  select id, cost, currency_id, is_active, stock into v_reward
    from public.economy_rewards
   where id = new.reward_id and family_id = new.family_id;
  if not found then
    raise exception 'that reward does not belong to this family'
      using errcode = '42501';
  end if;
  if not coalesce(v_reward.is_active, false) then
    raise exception 'that reward is not available'
      using errcode = '42501';
  end if;
  if new.cost is distinct from v_reward.cost then
    raise exception 'a reward costs what the family set for it, not %', new.cost
      using errcode = '42501';
  end if;
  if new.currency_id is distinct from v_reward.currency_id then
    raise exception 'a redemption must be priced in the reward''s own currency'
      using errcode = '42501';
  end if;

  return new;
end; $fn$;

drop trigger if exists trg_economy_redemption_request_guard on public.economy_redemptions;
create trigger trg_economy_redemption_request_guard
  before insert or update on public.economy_redemptions
  for each row execute function public.economy_redemption_request_guard();

revoke all on function public.economy_redemption_request_guard() from public;

-- ── The function that moves the tokens stops trusting the row ───────────────
create or replace function public.economy_decide_redemption(p_redemption_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  v_redemption record;
  v_reward     record;
  v_has_reward boolean := false;
  v_cost       bigint;
  v_balance    bigint;
  v_txn_id     uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select id, family_id, reward_id, currency_id, member_id, cost, status
    into v_redemption
    from public.economy_redemptions
   where id = p_redemption_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.can_manage_family(v_redemption.family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_redemption.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided');
  end if;

  if not p_approve then
    update public.economy_redemptions
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           note = left(nullif(trim(coalesce(p_note, '')), ''), 1000)
     where id = v_redemption.id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  v_cost := v_redemption.cost;

  if v_redemption.reward_id is not null then
    select id, stock, cost into v_reward
      from public.economy_rewards
     where id = v_redemption.reward_id
       and family_id = v_redemption.family_id
     for update;
    v_has_reward := found;
    if v_has_reward and v_reward.stock is not null and v_reward.stock <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'out_of_stock');
    end if;
    -- THE PRICE IS THE REWARD'S, not the redemption row's. The row is written by
    -- whoever asked; this one is written by a manager and is already locked
    -- above. Reading stock off it and the price off the request was the gap.
    if v_has_reward and v_reward.cost is not null then
      v_cost := v_reward.cost;
    end if;
  end if;

  perform 1
    from public.currency_transactions
   where family_id = v_redemption.family_id
     and currency_id = v_redemption.currency_id
     and member_id = v_redemption.member_id
   for update;
  select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::bigint
    into v_balance
    from public.currency_transactions
   where family_id = v_redemption.family_id
     and currency_id = v_redemption.currency_id
     and member_id = v_redemption.member_id;
  if v_balance < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_tokens');
  end if;

  insert into public.currency_transactions
    (family_id, currency_id, member_id, direction, amount, reason,
     related_type, related_id, created_by)
  values
    (v_redemption.family_id, v_redemption.currency_id, v_redemption.member_id,
     'debit', v_cost, 'Reward redeemed', 'redemption',
     v_redemption.id, auth.uid())
  returning id into v_txn_id;

  -- Write the charged price back, so the record and the ledger agree.
  update public.economy_redemptions
     set status = 'fulfilled', txn_id = v_txn_id, decided_by = auth.uid(),
         decided_at = now(), cost = v_cost,
         note = left(nullif(trim(coalesce(p_note, '')), ''), 1000)
   where id = v_redemption.id;

  if v_has_reward and v_reward.stock is not null then
    update public.economy_rewards
       set stock = stock - 1
     where id = v_reward.id and stock > 0;
  end if;

  return jsonb_build_object('ok', true, 'status', 'fulfilled', 'txn_id', v_txn_id, 'cost', v_cost);
end;
$function$;
