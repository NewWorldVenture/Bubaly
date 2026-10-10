-- ── A reward request is the reward's own snapshot ──────────────────────────
--
-- 0308 made a redemption carry the shelf's price, but its guard returned early
-- when reward_id was null and on an UPDATE that left cost_points alone, looked
-- the reward up by id alone, and never read reward_title. A child could queue
-- "New bike · 1 pts" five ways, each indistinguishable in the parent's queue
-- from a real request. The held 0500 completes the guard.
--
-- What this probe asserts, as an active child of the family through
-- PostgREST's role ("New bike" at 5000 and "Sticker" at 1 on the family's
-- shelf; "Sticker" at 1 on another family's), each attempt in its own
-- rolled-back subtransaction:
--
--   1. control: the real requests land (the bike at 5000, the sticker at 1,
--      each under its own title), as requestRedemptionAction writes them;
--   2. refused with 0500's sentences (23514), and nothing lands:
--        A  a ticket naming no reward;
--        B  a ticket naming another family's reward (as "New bike", and B2
--           at that reward's own title and price);
--        D  a ticket naming the family's own sticker under the bike's title;
--      and 0308's own refusal (the bike at 1 point) is unchanged;
--   3. refused on the child's own pending requests, and the row is unchanged:
--        C  clearing reward_id and re-pricing to 1 point;
--        E  retitling the sticker request "New bike";
--        F  re-pointing the sticker request at the bike;
--   4. control: the child still withdraws a request, and a parent still
--      approves one (decisions are untouched);
--   5. control: a parent deleting the reward leaves its pending ticket with the
--      title and price it was made with and reward_id null (ON DELETE SET
--      NULL, 0028's history);
--   6. control: the service role and a session-less writer (seeds) are exempt;
--   7. MUTATION CONTROLS, only where 0500 is installed, each in a rolled-back
--      subtransaction: with 0308's early return for a null reward_id put back
--      A lands; without the title check D lands; without the update refusal C
--      lands; without the own-family clause B2 lands.
--
-- Everything is rolled back.
--
-- HELD with 0500: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/reward-snapshot-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0500 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8500-0000000000a1','r0500-parent@example.com'),
  ('00000000-0000-4000-8500-0000000000a4','r0500-child@example.com'),
  ('00000000-0000-4000-8500-0000000000b1','r0500-other-parent@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8500-0000000000f1','Reward Snapshot House','00000000-0000-4000-8500-0000000000a1'),
  ('00000000-0000-4000-8500-0000000000f2','Other Reward House','00000000-0000-4000-8500-0000000000b1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8500-0000000000a1','00000000-0000-4000-8500-0000000000b1');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8500-0000000000c4','00000000-0000-4000-8500-0000000000f1','00000000-0000-4000-8500-0000000000a4','Kid','child',true);
insert into public.rewards (id, family_id, title, cost_points) values
  ('00000000-0000-4000-8500-0000000000e1','00000000-0000-4000-8500-0000000000f1','New bike',5000),
  ('00000000-0000-4000-8500-0000000000e3','00000000-0000-4000-8500-0000000000f1','Sticker',1),
  ('00000000-0000-4000-8500-0000000000e2','00000000-0000-4000-8500-0000000000f2','Sticker',1);
-- The child has earned enough for the sticker the parent approves in step 4.
with c as (insert into public.chores (family_id, title) values ('00000000-0000-4000-8500-0000000000f1','Dishes') returning id)
insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded)
  select '00000000-0000-4000-8500-0000000000f1', c.id, '00000000-0000-4000-8500-0000000000c4', 'approved', 10 from c;

do $$
declare
  fam       constant uuid := '00000000-0000-4000-8500-0000000000f1';
  kid       constant uuid := '00000000-0000-4000-8500-0000000000c4';
  bike      constant uuid := '00000000-0000-4000-8500-0000000000e1';
  sticker   constant uuid := '00000000-0000-4000-8500-0000000000e3';
  foreign_r constant uuid := '00000000-0000-4000-8500-0000000000e2';
  no_reward constant text := '23514: a reward request must name a reward of this family';
  bad_title constant text := '23514: redemption title is not this reward''s title';
  kept      constant text := '23514: a reward request keeps the reward, title and price it was made with';
  bad_price constant text := '23514: redemption cost 1 is not this reward''s price 5000';
  installed boolean := pg_get_functiondef('public.reward_redemption_cost_guard()'::regprocedure) ~ 'must name a reward of this family';
  failures  text[] := '{}';
  t         record;
  got       text;
  n         int;
  bike_req  uuid;
  stk_req   uuid;
  row_now   text;
begin
  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8500-0000000000a4', true);
  perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8500-0000000000a4','role','authenticated')::text, true);
  if public.can_manage_family(fam) or not public.is_family_member(fam) then
    raise exception 'CONTROL: not acting as a plain child of the family; nothing below is a boundary';
  end if;

  -- 1. The real requests land.
  begin
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
      values (fam, bike, kid, 'New bike', 5000, 'requested') returning id into bike_req;
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
      values (fam, sticker, kid, 'Sticker', 1, 'requested') returning id into stk_req;
  exception when others then
    failures := array_append(failures, format('CONTROL: the child''s real request was refused (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 2. Forged tickets.
  for t in select * from (values
      ('A', 'a ticket naming no reward, "New bike" at 1 point',               null::uuid, 'New bike', 1,    no_reward),
      ('B', 'a ticket naming another family''s 1-point reward as "New bike"', foreign_r,  'New bike', 1,    no_reward),
      ('B2','a ticket naming another family''s reward at its own title and price', foreign_r, 'Sticker', 1,  no_reward),
      ('D', 'a ticket naming the family''s own sticker as "New bike"',        sticker,    'New bike', 1,    bad_title),
      ('P', 'the family''s own bike at 1 point (0308''s case)',               bike,       'New bike', 1,    bad_price)
    ) as v(k, what, rid, title, cost, want) loop
    begin
      insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
        values (fam, t.rid, kid, t.title, t.cost, 'requested');
      got := 'landed';
      raise exception using errcode = 'P0R01';
    exception
      when sqlstate 'P0R01' then null;
      when others then got := sqlstate || ': ' || sqlerrm;
    end;
    if got = 'landed' then
      failures := array_append(failures, format('%s: a child queued %s', t.k, t.what));
    elsif got is distinct from t.want then
      failures := array_append(failures, format('%s: %s was refused, but not by the snapshot guard (%s)', t.k, t.what, got));
    end if;
  end loop;

  -- 3. Rewriting the child's own pending requests.
  for t in select * from (values
      ('C', 'cleared reward_id and re-priced their pending bike request to 1 point',
            format('update public.reward_redemptions set reward_id = null, cost_points = 1 where id = %L', bike_req), bike_req),
      ('E', 'retitled their pending sticker request "New bike"',
            format('update public.reward_redemptions set reward_title = %L where id = %L', 'New bike', stk_req), stk_req),
      ('F', 're-pointed their pending sticker request at the bike',
            format('update public.reward_redemptions set reward_id = %L, reward_title = %L, cost_points = 5000 where id = %L', bike, 'New bike', stk_req), stk_req)
    ) as v(k, what, sql, rid) loop
    begin
      execute t.sql;
      get diagnostics n = row_count;
      got := format('%s row(s)', n);
      raise exception using errcode = 'P0R01';
    exception
      when sqlstate 'P0R01' then null;
      when others then got := sqlstate || ': ' || sqlerrm;
    end;
    if got is distinct from kept then
      failures := array_append(failures, format('%s: a child %s (%s)', t.k, t.what, got));
    end if;
  end loop;
  perform set_config('role','postgres', true);
  select string_agg(reward_title || '/' || cost_points || '/' || coalesce(reward_id::text, 'none'), ', ' order by cost_points)
    into row_now from public.reward_redemptions where id in (bike_req, stk_req);
  if row_now is distinct from format('Sticker/1/%s, New bike/5000/%s', sticker, bike) then
    failures := array_append(failures, format('the child''s pending requests changed: %s', row_now));
  end if;

  -- 4. Withdrawals and decisions are untouched.
  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8500-0000000000a4', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8500-0000000000a4','role','authenticated')::text, true);
    update public.reward_redemptions set status = 'cancelled' where id = bike_req;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('CONTROL: the child''s withdrawal changed %s rows', n)); end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: the child could not withdraw their request (%s: %s)', sqlstate, sqlerrm));
  end;
  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8500-0000000000a1', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8500-0000000000a1','role','authenticated')::text, true);
    update public.reward_redemptions set status = 'approved',
           decided_by = (select id from public.family_members where user_id = '00000000-0000-4000-8500-0000000000a1' and family_id = fam),
           decided_at = now()
     where id = stk_req;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('CONTROL: the parent''s approval changed %s rows', n)); end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: the parent could not approve a real request (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 5. Deleting the reward keeps the ticket's snapshot.
  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8500-0000000000a1', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8500-0000000000a1','role','authenticated')::text, true);
    delete from public.rewards where id = bike;
    get diagnostics n = row_count;
    perform set_config('role','postgres', true);
    select reward_title || '/' || cost_points || '/' || coalesce(reward_id::text, 'none') into row_now
      from public.reward_redemptions where id = bike_req;
    if n <> 1 or row_now is distinct from 'New bike/5000/none' then
      failures := array_append(failures, format('CONTROL: deleting the reward did not leave its ticket as made (deleted %s, ticket %s)', n, row_now));
    end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: a parent could not delete a reward that a pending request names (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 6. The service role and a session-less writer are exempt.
  begin
    perform set_config('role','service_role', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', json_build_object('role','service_role')::text, true);
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
      values (fam, null, kid, 'Backfilled', 3, 'requested');
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: the service role was refused (%s: %s)', sqlstate, sqlerrm));
  end;
  begin
    perform set_config('role','postgres', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
      values (fam, null, kid, 'Seeded', 3, 'requested');
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: a session-less writer was refused (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 7. Mutation controls.
  if installed then
    for t in select * from (values
        ('M1', 'with 0308''s early return for a null reward_id put back, the child''s ticket naming no reward',
               'select r.family_id, r.title, r.cost_points into shelf',
               'if new.reward_id is null then return new; end if; select r.family_id, r.title, r.cost_points into shelf',
               format('insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status) values (%L, null, %L, %L, 1, %L)', fam, kid, 'New bike', 'requested')),
        ('M2', 'without the title check, the child''s sticker ticket titled "New bike"',
               'if new.reward_title is distinct from shelf.title then', 'if false then',
               format('insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status) values (%L, %L, %L, %L, 1, %L)', fam, sticker, kid, 'New bike', 'requested')),
        ('M3', 'without the update refusal, the child''s re-pricing of their bike request',
               'raise exception ''a reward request keeps the reward, title and price it was made with''', 'return new; raise exception ''x''',
               format('update public.reward_redemptions set reward_id = null, cost_points = 1 where id = %L', bike_req)),
        ('M4', 'without the own-family clause, the child''s ticket naming another family''s reward',
               'or shelf.family_id is distinct from new.family_id', '',
               format('insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status) values (%L, %L, %L, %L, 1, %L)', fam, foreign_r, kid, 'Sticker', 'requested'))
      ) as v(k, what, find, repl, sql) loop
      begin
        execute replace(pg_get_functiondef('public.reward_redemption_cost_guard()'::regprocedure), t.find, t.repl);
        perform set_config('role','authenticated', true);
        perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8500-0000000000a4', true);
        perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8500-0000000000a4','role','authenticated')::text, true);
        begin
          execute t.sql;
          get diagnostics n = row_count;
          got := format('%s row(s)', n);
        exception when others then got := sqlstate || ': ' || sqlerrm;
        end;
        perform set_config('role','postgres', true);
        if got is distinct from '1 row(s)' then
          failures := array_append(failures, format('MUTATION CONTROL %s: %s still did not land (%s), so the refusal above is not attributed to that clause', t.k, t.what, got));
        end if;
        raise exception using errcode = 'P0R01';
      exception when sqlstate 'P0R01' then null;
      end;
      perform set_config('role','postgres', true);
    end loop;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a reward request is not the reward''s own snapshot:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-reward-request-is-the-rewards-own-snapshot: OK (as a child: the real bike and sticker requests landed; a ticket naming no reward, another family''s reward, or the sticker under the bike''s title was refused with 0500''s sentences and the bike at 1 point with 0308''s; clearing, re-pricing, retitling and re-pointing their own pending requests were refused and nothing changed; withdrawing and a parent''s approval still land; deleting a reward leaves its ticket as made; the service role and a session-less writer are exempt; mutation controls M1-M4 each let the forgery back in)';
end $$;

rollback;
