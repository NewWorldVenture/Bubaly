-- The rows a parent's money decision trusts are written by parents. (SEC-017, migration 0329)
--
-- `wallet_approve_gift` credits whatever wallet and amount a pending
-- gift_payment names when a parent approves it. Before 0329 any family member
-- could rewrite that row, invent one, or repoint the gift link it came from:
-- measured with real sessions, Grandma's $50 for Sister became $500 for Brother,
-- an invented $20,000 "Uncle Joe" gift was credited beside it, and after the
-- parent approved the queue Sister had $0.00 and Brother $20,500.00.
--
--   a child edits a pending pledge (amount, wallet)   -> REFUSED
--   a child invents a pledge                          -> REFUSED
--   a child repoints or deletes a gift link           -> REFUSED
--   the public pledge path (service role)             -> allowed  (control)
--   a parent creates a link and dismisses a pledge    -> allowed  (control)
--   a parent's approval credits the child it was for  -> allowed  (control)
--   a child can still see the gift sent to them       -> allowed  (control)
--   a child forges a goal "reached" with no ledger     -> REFUSED
--   a child repoints a goal or a Pay-ID                -> REFUSED
--   a parent creates and funds a goal, claims a Pay-ID -> allowed  (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  par      uuid := '00000000-0000-4000-8000-00000000a901';
  sis      uuid := '00000000-0000-4000-8000-00000000a902';
  bro      uuid := '00000000-0000-4000-8000-00000000a903';
  fam      uuid := '00000000-0000-4000-8000-00000000a911';
  m_sis    uuid;
  m_bro    uuid;
  w_sis    uuid;
  w_bro    uuid;
  link     uuid;
  pledge   uuid;
  spare    uuid;
  res      jsonb;
  credited bigint;
  n        int;
  failures int := 0;
  k        text;
  i        int := 0;
  goal     uuid;
  leak     text;
  payid    uuid;
begin
  -- ── 0. structure: what a money function reads, a non-manager cannot rewrite ──
  -- The general form of this finding. Every SECURITY DEFINER function that
  -- credits a ledger reads its amount and destination from some row; if a
  -- non-manager can UPDATE that row, they choose the outcome of a decision a
  -- parent thinks they are making. A table passes when every permissive
  -- UPDATE/ALL policy on it is manager-only, or a restrictive manager guard
  -- ANDs with the rest. This would have caught all four tables 0329 fixes, and
  -- it catches the next RPC that reads from a member-writable table.
  select string_agg(distinct format('%s (read by %s)', src.tbl, src.fn), ', ')
    into leak
    from (
      select p.proname as fn, lower(m[1]) as tbl
        from pg_proc p
        join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public'
        cross join lateral regexp_matches(pg_get_functiondef(p.oid), 'from\s+public\.([a-z_0-9]+)', 'gi') as m
       where p.prosecdef
         and p.proname <> 'wallet_credit_child_ledger'
         and pg_get_functiondef(p.oid) ~* '(wallet_credit_child_ledger\(|insert into public\.(wallet_transactions|currency_transactions|invest_holdings))'
    ) src
    join pg_class c on c.relname = src.tbl and c.relnamespace = 'public'::regnamespace
   where exists (
           select 1 from pg_policy pp
            where pp.polrelid = c.oid and pp.polpermissive and pp.polcmd in ('w', '*')
              and pg_get_expr(pp.polqual, pp.polrelid) not ilike '%can_manage_family%')
     and not exists (
           select 1 from pg_policy g
            where g.polrelid = c.oid and not g.polpermissive and g.polcmd in ('w', '*')
              and pg_get_expr(g.polqual, g.polrelid) ilike '%can_manage_family%');
  if leak is not null then
    raise warning 'BREACH: a money function reads rows a non-manager can rewrite: %', leak;
    failures := failures + 1;
  end if;

  insert into auth.users (id, email) values
    (par, 'gift-parent@example.test'), (sis, 'gift-sister@example.test'), (bro, 'gift-brother@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Gift', par) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, par, 'Parent', 'parent', true), (fam, sis, 'Sister', 'child', true), (fam, bro, 'Brother', 'child', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_sis from public.family_members where family_id = fam and user_id = sis;
  select id into m_bro from public.family_members where family_id = fam and user_id = bro;
  insert into public.child_wallets (family_id, member_id, created_by) values (fam, m_sis, par) returning id into w_sis;
  insert into public.child_wallets (family_id, member_id, created_by) values (fam, m_bro, par) returning id into w_bro;
  foreach k in array array['spend', 'save', 'give', 'invest'] loop
    insert into public.wallet_buckets (family_id, child_wallet_id, kind, label, sort_order) values
      (fam, w_sis, k::public.wallet_bucket_kind, k, i), (fam, w_bro, k::public.wallet_bucket_kind, k, i);
    i := i + 1;
  end loop;

  -- ── control: a parent creates the link, as the product does ─────────────
  perform set_config('request.jwt.claims', json_build_object('sub', par::text)::text, true);
  set local role authenticated;
  begin
    insert into public.gift_links (family_id, child_wallet_id, token, occasion, created_by)
      values (fam, w_sis, 'gift-probe-token', 'birthday', par) returning id into link;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: a parent could not create a gift link — the fix took the feature away';
    failures := failures + 1;
  end;
  reset role;
  if link is null then
    insert into public.gift_links (family_id, child_wallet_id, token, occasion, created_by)
      values (fam, w_sis, 'gift-probe-token', 'birthday', par) returning id into link;
  end if;

  -- ── control: the public pledge path writes through the service role ─────
  set local role service_role;
  insert into public.gift_payments (family_id, gift_link_id, child_wallet_id, giver_name, amount_cents, status, occasion)
    values (fam, link, w_sis, 'Grandma', 5000, 'pending', 'birthday') returning id into pledge;
  insert into public.gift_payments (family_id, gift_link_id, child_wallet_id, giver_name, amount_cents, status, occasion)
    values (fam, link, w_sis, 'Aunt May', 2500, 'pending', 'birthday') returning id into spare;
  reset role;

  -- ── the attacks, as Brother ─────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', bro::text)::text, true);
  set local role authenticated;
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a family member, so no refusal below means anything';
  end if;
  select count(*) into n from public.gift_payments where id = pledge;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a child cannot see the family''s pending gifts at all';
    failures := failures + 1;
  end if;

  begin
    update public.gift_payments set amount_cents = 50000, child_wallet_id = w_bro where id = pledge;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child rewrote a pending gift''s amount and recipient (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.gift_payments (family_id, child_wallet_id, giver_name, amount_cents, status, occasion)
      values (fam, w_bro, 'Uncle Joe', 2000000, 'pending', 'birthday');
    raise warning 'BREACH: a child invented a $20,000 gift to themselves';
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.gift_links set child_wallet_id = w_bro where id = link;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child repointed a sibling''s gift link at themselves (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.gift_payments where id = spare;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child deleted a sibling''s pending gift (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;

  -- ── the parent approves, and it lands where Grandma sent it ─────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', par::text)::text, true);
  set local role authenticated;
  res := public.wallet_approve_gift(fam, pledge, par);
  if coalesce((res ->> 'ok')::boolean, false) is not true then
    raise warning 'CONTROL FAILED: the parent could not approve the gift: %', res;
    failures := failures + 1;
  end if;
  begin
    update public.gift_payments set status = 'cancelled' where id = spare;
    get diagnostics n = row_count;
    if n <> 1 then raise warning 'CONTROL FAILED: a parent could not dismiss a pledge (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: a parent was refused dismissing a pledge';
    failures := failures + 1;
  end;
  reset role;

  select coalesce(sum(amount_cents), 0) into credited from public.wallet_transactions where child_wallet_id = w_sis;
  if credited <> 5000 then
    raise warning 'the approved gift credited Sister % cents, not the 5000 Grandma sent', credited;
    failures := failures + 1;
  end if;
  select coalesce(sum(amount_cents), 0) into credited from public.wallet_transactions where child_wallet_id = w_bro;
  if credited <> 0 then
    raise warning 'BREACH: Brother''s wallet was credited % cents from gifts that were not his', credited;
    failures := failures + 1;
  end if;

  -- ── and Sister can see what she was sent ────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', sis::text)::text, true);
  set local role authenticated;
  select count(*) into n from public.gift_payments where id = pledge and status = 'completed';
  if n <> 1 then
    raise warning 'CONTROL FAILED: the child cannot see the gift that was credited to her';
    failures := failures + 1;
  end if;
  reset role;

  -- ── goals and Pay-IDs: a parent sets them up ────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', par::text)::text, true);
  set local role authenticated;
  begin
    insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, created_by)
      values (fam, w_sis, 'Bike', 30000, par) returning id into goal;
    insert into public.pay_handles (family_id, child_wallet_id, handle, created_by)
      values (fam, w_sis, 'probe_sister', par) returning id into payid;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: a parent could not create a goal or claim a Pay-ID';
    failures := failures + 1;
  end;
  reset role;
  if goal is null then
    insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, created_by)
      values (fam, w_sis, 'Bike', 30000, par) returning id into goal;
  end if;
  if payid is null then
    insert into public.pay_handles (family_id, child_wallet_id, handle, created_by)
      values (fam, w_sis, 'probe_sister', par) returning id into payid;
  end if;

  -- ── Brother forges and repoints ─────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', bro::text)::text, true);
  set local role authenticated;
  begin
    update public.wallet_goals set saved_cents = 30000, status = 'reached' where id = goal;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child marked a $300 goal saved and reached with no ledger behind it (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.wallet_goals set child_wallet_id = w_bro where id = goal;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child repointed a sibling''s goal at their own wallet (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pay_handles set child_wallet_id = w_bro where id = payid;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a child repointed a sibling''s Pay-ID at their own wallet (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.wallet_goals where id = goal;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a child cannot see the family''s goals';
    failures := failures + 1;
  end if;
  reset role;

  if failures > 0 then
    raise exception 'the rows a parent''s money decision trusts are not parent-written: % finding(s)', failures;
  end if;
  raise notice 'OK: children cannot edit, invent, repoint or delete gifts, forge goals or repoint Pay-IDs; every parent and public path is unchanged.';
end
$probe$;

rollback;
