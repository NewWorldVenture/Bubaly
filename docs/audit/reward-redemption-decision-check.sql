-- Behavioural proof for 0295, run as a real `authenticated` session under RLS.
--
-- reward_redemptions shipped (0028) with one `FOR ALL … is_family_member`
-- policy and no trigger, and BOTH of its write paths are direct browser writes
-- that choose `status` and `decided_by` client-side. So a child could insert a
-- redemption already marked 'approved', or approve one sitting in the queue —
-- self-granting a reward no parent agreed to.
--
-- This is the third of three decision surfaces in the chores/rewards economy.
-- 0222 closed the submission forge, 0223 the assignment-status forge, and this
-- one is their sibling. Like them it mints no money: the wallet is separately
-- manager-only under 0217. It is an accountability forgery.
--
-- What a member may still do is asserted alongside what they may not, because a
-- guard that also blocks asking for a reward would be a different bug.
-- Wrapped in a transaction that is always rolled back.
--
-- This probe COMMITTED everything it seeded, and its own assertions count rows
-- — a second run against the same database fails on
-- `family_members_family_id_user_id_key`, because run one's member rows are
-- still there under a different generated primary key.
-- It was masked for as long as it existed: this file and
-- ai-surface-role-privacy-check.sql shared the family id
-- `dddddddd-…`, so whichever ran second had its whole seed skipped by
-- `on conflict do nothing` and never reached its own defect. Giving each probe
-- its own ids (tests/boundary-probes-are-rerunnable.test.ts pins that) is what
-- surfaced it.
--
-- CI never saw any of this, because the Database job bootstraps a fresh
-- container every time and the suite had only ever been run ONCE per database.
begin;
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'ddddbbbb-dddd-4ddd-8ddd-dddddddddddd';
  parent_uid uuid := 'd0000000-0000-4000-8000-0000000000b1';
  child_uid  uuid := 'd0000000-0000-4000-8000-0000000000b2';
  parent_mid uuid;
  child_mid  uuid;
  red        uuid;
  blocked    boolean;
  n          int;
begin
  insert into public.families (id, name) values (fam, 'Rewards') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'rp@example.test'), (child_uid, 'rc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  -- ── As the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Cannot mint an already-approved redemption.
  blocked := false;
  begin
    insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status, decided_by)
    values (fam, child_mid, 'Extra screen time', 100, 'approved', child_mid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted an APPROVED reward redemption';
  end if;

  -- 2. May still ASK. A guard that blocked this would break the product.
  insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status)
  values (fam, child_mid, 'Extra screen time', 100, 'requested') returning id into red;

  -- 3. Cannot approve the request they just made.
  blocked := false;
  begin
    update public.reward_redemptions set status = 'approved', decided_by = child_mid where id = red;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child approved their own queued reward redemption';
  end if;

  -- 4. Cannot jump straight to fulfilled either.
  blocked := false;
  begin
    update public.reward_redemptions set status = 'fulfilled' where id = red;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child marked their own reward redemption fulfilled';
  end if;

  -- 5. May withdraw their own ask. Cancelling needs no parent.
  update public.reward_redemptions set status = 'cancelled' where id = red;
  select count(*) into n from public.reward_redemptions where id = red and status = 'cancelled';
  if n <> 1 then
    raise exception 'a child could not cancel their own reward request';
  end if;

  -- ── As the parent ────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  -- 6. A manager decides, which is the whole point of the queue.
  update public.reward_redemptions set status = 'approved', decided_by = parent_mid where id = red;
  update public.reward_redemptions set status = 'fulfilled' where id = red;
  select count(*) into n from public.reward_redemptions where id = red and status = 'fulfilled';
  if n <> 1 then
    raise exception 'a parent could not approve and fulfil a reward redemption';
  end if;

  reset role;
  raise notice 'OK  reward redemption decisions are a manager''s alone; asking and cancelling are not';
end $$;

rollback;
