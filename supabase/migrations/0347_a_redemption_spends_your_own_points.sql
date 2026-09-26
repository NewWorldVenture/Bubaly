-- Bubaly :: 0347 - a redemption spends your own points
--
-- reward_redemptions (points) and economy_redemptions (tokens) record a reward
-- bought with a member's balance. Balances are computed from these rows by
-- member_id.
--
-- reward_redemptions was member FOR ALL. Its decision guard covers status and
-- its cost guard covers cost_points, but nothing covered member_id - so a
-- child could re-point an APPROVED redemption at a sibling and move the points
-- they had spent onto the sibling's balance, file a request that spends a
-- sibling's points, or delete a sibling's request. economy_redemptions INSERT
-- likewise accepted any member_id.
--
-- Worse, points are spent only by 'approved' / 'fulfilled' rows and the
-- decision guard only blocks a move TO a decision: a child could move their
-- own approved redemption back to 'requested' or 'cancelled' and have the
-- points back.
--
-- The application requests through requestRedemptionAction (rewards and
-- economy), which now lets a non-manager request only for themselves, and
-- decides through the manager-only decideRedemptionAction. So:
--   INSERT  for yourself, or a manager for anyone
--   UPDATE  a manager; or your own row while 'requested', to 'requested' or
--           'cancelled' (withdrawing an ask, which 0295 keeps)
--   DELETE  a manager
-- economy_redemptions UPDATE/DELETE were already manager-only.
--
-- Pinned by docs/audit/redemption-owner-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.reward_redemptions') is not null then
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'reward_redemptions' loop
      execute format('drop policy %I on public.reward_redemptions', p.policyname);
    end loop;
    create policy reward_redemptions_select on public.reward_redemptions for select to authenticated
      using (public.is_family_member(family_id));
    create policy reward_redemptions_insert on public.reward_redemptions for insert to authenticated
      with check (public.is_family_member(family_id)
        and (public.is_self_member(member_id) or public.can_manage_family(family_id)));
    -- A member may withdraw their own ask (0295's probe asserts it) - and only
    -- that: their own row, while it is still 'requested', to 'requested' or
    -- 'cancelled'. Points are spent by 'approved' / 'fulfilled' rows, and 0295's
    -- guard only stops a move TO a decision, so without the USING clause a
    -- child could move an approved redemption back to 'cancelled' and get the
    -- points back.
    create policy reward_redemptions_update on public.reward_redemptions for update to authenticated
      using (public.can_manage_family(family_id)
        or (public.is_self_member(member_id) and status = 'requested'))
      with check (public.can_manage_family(family_id)
        or (public.is_self_member(member_id) and status in ('requested', 'cancelled')));
    create policy reward_redemptions_delete on public.reward_redemptions for delete to authenticated
      using (public.can_manage_family(family_id));
  end if;

  if to_regclass('public.economy_redemptions') is not null then
    drop policy if exists economy_redemptions_insert on public.economy_redemptions;
    create policy economy_redemptions_insert on public.economy_redemptions for insert to authenticated
      with check (public.is_family_member(family_id)
        and (public.is_self_member(member_id) or public.can_manage_family(family_id)));
  end if;
end
$$;
