-- Behavioural proof for 0460, run as a real `authenticated` session under RLS.
--
-- Page audit B11 (finalaudit.md) watched a child signed in with a PIN add a
-- family subscription. This probe makes the child's three other writes too —
-- re-price, cancel, delete — and expects all four refused, while the child
-- still reads the list (0460 closes writes only).
--
-- NEGATIVE CONTROL, as money-write-boundary-check.sql: an UPDATE or DELETE the
-- child may not make reports what one against a missing row reports — nothing
-- — and an INSERT's 42501 is also what a missing GRANT raises. So before any
-- refusal, the SAME child session makes the same four writes in a second
-- household where they are a parent. Only `can_manage_family(family_id)`
-- differs; if a control write is refused, this reports CONTROL FAILED rather
-- than crediting 0460 with a refusal it did not measure.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0460';
  ctl_fam    uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeee046c';
  parent_uid uuid := 'e0000000-0000-4000-8000-000000000461';
  child_uid  uuid := 'e0000000-0000-4000-8000-000000000462';
  sub        uuid;
  ctl_sub    uuid;
  why        text;
  n          int;
  blocked    boolean;
  r          record;
begin
  insert into public.families (id, name) values (fam, 'Subscriptions'), (ctl_fam, 'Subscriptions (control)')
    on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'sp@example.test'), (child_uid, 'sc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true),
         (fam, child_uid, 'Child', 'child', true),
         (ctl_fam, child_uid, 'Grown-up elsewhere', 'parent', true)
  on conflict do nothing;

  insert into public.subscriptions_tracked (family_id, name, cost_cents, cadence)
  values (fam, 'Streaming', 1599, 'monthly') returning id into sub;
  insert into public.subscriptions_tracked (family_id, name, cost_cents, cadence)
  values (ctl_fam, 'Control', 100, 'monthly') returning id into ctl_sub;

  -- ── No policy may quietly re-open what this one closes ───────────────────
  -- 0076's "Members manage subscriptions_tracked" was FOR ALL; permissive
  -- policies are OR'd, so a wide one left beside the four named ones would be
  -- the real rule. Every write policy must be exactly can_manage_family.
  for r in
    select policyname, cmd, permissive,
           coalesce(qual, '(none)') as using_expr, coalesce(with_check, '(none)') as check_expr
      from pg_policies
     where schemaname = 'public' and tablename = 'subscriptions_tracked' and cmd <> 'SELECT'
       and (coalesce(qual,       'can_manage_family(family_id)') <> 'can_manage_family(family_id)'
         or coalesce(with_check, 'can_manage_family(family_id)') <> 'can_manage_family(family_id)')
  loop
    raise exception 'policy subscriptions_tracked.% (% %) does not gate writes on can_manage_family alone: using=%, with check=%',
      r.policyname, r.permissive, r.cmd, r.using_expr, r.check_expr;
  end loop;

  -- ── As the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- Reading is unchanged, deliberately: and a row the child cannot see would
  -- turn checks 2-4 into visibility refusals credited to the write boundary.
  select count(*) into n from public.subscriptions_tracked where id = sub;
  if n <> 1 then raise exception 'the child cannot SEE the family subscription; 0460 was meant to leave reads alone'; end if;

  -- ── NEGATIVE CONTROL ─────────────────────────────────────────────────────
  if current_user <> 'authenticated' then
    raise exception 'CONTROL FAILED: these writes run as %, not authenticated', current_user;
  end if;
  if auth.uid() is distinct from child_uid then
    raise exception 'CONTROL FAILED: auth.uid() is % rather than the child', coalesce(auth.uid()::text, 'null');
  end if;
  why := null;
  begin
    insert into public.subscriptions_tracked (family_id, name, cost_cents) values (ctl_fam, 'Control add', 100);
  exception when insufficient_privilege then why := sqlerrm;
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: the child could not add a subscription in a family they DO manage (%), so check 1 would prove nothing', why;
  end if;
  update public.subscriptions_tracked set cost_cents = 200 where id = ctl_sub;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'CONTROL FAILED: the child could not re-price a subscription they DO manage'; end if;
  update public.subscriptions_tracked set status = 'canceled' where id = ctl_sub;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'CONTROL FAILED: the child could not cancel a subscription they DO manage'; end if;
  delete from public.subscriptions_tracked where id = ctl_sub;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'CONTROL FAILED: the child could not delete a subscription they DO manage'; end if;

  -- ── The four refusals ────────────────────────────────────────────────────
  blocked := false;
  begin
    insert into public.subscriptions_tracked (family_id, name, cost_cents) values (fam, 'Child added', 999);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception '1: a child added a family subscription'; end if;

  update public.subscriptions_tracked set cost_cents = 1 where id = sub;
  if found then raise exception '2: a child re-priced a family subscription'; end if;

  update public.subscriptions_tracked set status = 'canceled' where id = sub;
  if found then raise exception '3: a child cancelled a family subscription'; end if;

  delete from public.subscriptions_tracked where id = sub;
  if found then raise exception '4: a child deleted a family subscription'; end if;

  -- ── As the parent ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  insert into public.subscriptions_tracked (family_id, name, cost_cents) values (fam, 'Gym', 4500);
  update public.subscriptions_tracked set cost_cents = 1699 where id = sub;
  if not found then raise exception 'a parent cannot re-price their own subscription'; end if;
  delete from public.subscriptions_tracked where id = sub;
  if not found then raise exception 'a parent cannot delete their own subscription'; end if;

  reset role;
  delete from public.subscriptions_tracked where family_id in (fam, ctl_fam);
  delete from public.family_members where family_id in (fam, ctl_fam);
  delete from public.families where id in (fam, ctl_fam);
  delete from auth.users where id in (parent_uid, child_uid);
  raise notice 'subscription write boundary check passed (the same child first made all four writes in a household they DO manage)';
end $$;
