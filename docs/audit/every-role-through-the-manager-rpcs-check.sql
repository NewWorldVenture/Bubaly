-- ── Every role through the manager-only decision and money RPCs ────────────
--
-- The DB-RPC rows close on "each role (parent, adult, teen, child, caregiver,
-- guest) through the workflow that calls it". The probes that name these nine
-- functions exercise them mostly as a parent and a child; two of them,
-- wallet_decide_allowance and wallet_transfer, had no probe at all. Each is
-- SECURITY DEFINER, so RLS does not apply inside it and its own caller check
-- is the whole boundary:
--
--   economy_decide_redemption   guardian_review_suggestion   invest_decide_order
--   wallet_approve_gift         wallet_debit_spend_bucket    wallet_decide_allowance
--   wallet_decide_spend         wallet_fund_goal             wallet_transfer
--   move_recalculate_date       vacation_import_confirmation
--
-- (The last two take the caller's own member id and raise their refusal
-- rather than answer it; each actor passes their own member row.)
--
-- Nine actors call all eleven, through PostgREST's roles, against the same
-- pending rows: a parent, adult, teen, child, caregiver and guest of one
-- family, a REMOVED parent of it, a parent of another family, and anon. Each
-- call runs in a subtransaction that is always rolled back, so every actor
-- meets the row exactly as the first did.
--
--   * the parent and the adult must get PAST the gate (any answer but
--     'forbidden' / 'unauthenticated' / an error), because can_manage_family
--     is parent-or-adult;
--   * the other seven must be refused BY THE FUNCTION'S OWN GATE: 'forbidden'
--     or 'unauthenticated', or, for anon only, 42501 where it holds no
--     EXECUTE. Any other error fails, including a 42501 from deeper in: two of
--     these (economy and invest) also carry decision-guard triggers that
--     refuse a non-manager on their own, a second layer that is good to have
--     but would hide a gate that is not there.
--
-- The three that read their row before the gate (economy, guardian, invest)
-- are given real pending rows; the six wallet functions gate first, so an
-- unknown id still separates "admitted" ('not_found' and friends) from
-- "refused" ('forbidden').
--
-- The predicates the gates are built from are asserted for the same actors:
-- can_manage_family, is_family_admin, is_family_member and family_role, and
-- the social module's social_role_for (parent admin, adult marketing manager,
-- teen content creator, everyone else read-only, non-members none) and
-- social_has_permission for publish_posts (the parent and the adult only).
--
-- MUTATION CONTROLS. Inside the transaction, one row-first gate
-- (guardian_review_suggestion) and one gate-first gate (wallet_transfer) are
-- loosened from can_manage_family to is_family_member, and the child must then
-- get past each. That proves the matrix can see a gate that has been weakened.
-- Everything is rolled back.
--
-- Not claimed here: the app-side workflow per role (server actions, pages).
-- This is the database boundary only.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8a11-0000000000a1','roles-parent@example.com'),
  ('00000000-0000-4000-8a11-0000000000a2','roles-adult@example.com'),
  ('00000000-0000-4000-8a11-0000000000a3','roles-teen@example.com'),
  ('00000000-0000-4000-8a11-0000000000a4','roles-child@example.com'),
  ('00000000-0000-4000-8a11-0000000000a5','roles-caregiver@example.com'),
  ('00000000-0000-4000-8a11-0000000000a6','roles-guest@example.com'),
  ('00000000-0000-4000-8a11-0000000000a7','roles-removed@example.com'),
  ('00000000-0000-4000-8a11-0000000000b1','roles-outsider@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8a11-0000000000f1','Every Role House','00000000-0000-4000-8a11-0000000000a1'),
  ('00000000-0000-4000-8a11-0000000000f2','Outsider House','00000000-0000-4000-8a11-0000000000b1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8a11-0000000000a1','00000000-0000-4000-8a11-0000000000b1');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8a11-0000000000d2','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8a11-0000000000d3','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8a11-0000000000d4','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8a11-0000000000d5','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8a11-0000000000d6','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8a11-0000000000d7','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000a7','Removed Parent','parent',false);

-- The pending rows the row-first functions read before their gate.
insert into public.child_wallets (id, family_id, member_id) values
  ('00000000-0000-4000-8a11-0000000000c1','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000d4');
insert into public.family_currencies (id, family_id, name) values
  ('00000000-0000-4000-8a11-0000000000e1','00000000-0000-4000-8a11-0000000000f1','Stars');
insert into public.economy_redemptions (id, family_id, currency_id, member_id, title, cost) values
  ('00000000-0000-4000-8a11-0000000000e2','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000e1',
   '00000000-0000-4000-8a11-0000000000d4','Movie night',1);
insert into public.guardian_suggestions (id, family_id, suggestion_type, title, reasoning) values
  ('00000000-0000-4000-8a11-0000000000e3','00000000-0000-4000-8a11-0000000000f1','flag_scam','Flag a caller','probe');
insert into public.invest_assets (id, symbol, name, price_cents) values
  ('00000000-0000-4000-8a11-0000000000e4','PRBX','Probe Asset',100);
insert into public.invest_orders (id, family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents) values
  ('00000000-0000-4000-8a11-0000000000e5','00000000-0000-4000-8a11-0000000000f1','00000000-0000-4000-8a11-0000000000c1',
   '00000000-0000-4000-8a11-0000000000e4','buy',1,100,100);

do $$
declare
  fam      uuid := '00000000-0000-4000-8a11-0000000000f1';
  wallet   uuid := '00000000-0000-4000-8a11-0000000000c1';
  nowhere  uuid := '00000000-0000-4000-8a11-00000000ffff';
  failures text[] := '{}';
  a        record;
  c        record;
  r        text;
  raised   text;
  admitted boolean;
  calls    int := 0;
  original_def text;
  got      text;
  own_refusal boolean;
  parent_member   uuid;
  outsider_member uuid;
  actor_member    uuid;
begin
  select id into parent_member from public.family_members
   where family_id = fam and user_id = '00000000-0000-4000-8a11-0000000000a1';
  select id into outsider_member from public.family_members
   where family_id = '00000000-0000-4000-8a11-0000000000f2' and user_id = '00000000-0000-4000-8a11-0000000000b1';

  for a in select * from (values
      ('parent',          '00000000-0000-4000-8a11-0000000000a1'::uuid, 'authenticated', true,  true,  true,  'parent',    'admin',             true),
      ('adult',           '00000000-0000-4000-8a11-0000000000a2'::uuid, 'authenticated', true,  false, true,  'adult',     'marketing_manager', true),
      ('teen',            '00000000-0000-4000-8a11-0000000000a3'::uuid, 'authenticated', false, false, true,  'teen',      'content_creator',   false),
      ('child',           '00000000-0000-4000-8a11-0000000000a4'::uuid, 'authenticated', false, false, true,  'child',     'read_only',         false),
      ('caregiver',       '00000000-0000-4000-8a11-0000000000a5'::uuid, 'authenticated', false, false, true,  'caregiver', 'read_only',         false),
      ('guest',           '00000000-0000-4000-8a11-0000000000a6'::uuid, 'authenticated', false, false, true,  'guest',     'read_only',         false),
      -- family_role reads the row whatever its activity, so a removed parent
      -- still answers 'parent'. Recorded, not asserted as a defect: its one
      -- consumer, the guest write guard (0464), only uses it to refuse, and
      -- every policy that would admit them reads is_family_member, which is
      -- false. If that ever changes, this line fails on purpose.
      ('removed parent',  '00000000-0000-4000-8a11-0000000000a7'::uuid, 'authenticated', false, false, false, 'parent',    null,                false),
      ('outsider parent', '00000000-0000-4000-8a11-0000000000b1'::uuid, 'authenticated', false, false, false, null,        null,                false),
      ('anon',            null::uuid,                                   'anon',          false, false, false, null,        null,                false)
    ) as v(label, uid, pg_role, manages, admin, member, role, social, publishes) loop

    -- The predicates, as this actor. Read inside a rolled-back block so the
    -- role switch cannot leak into the next actor.
    begin
      perform set_config('role', a.pg_role, true);
      perform set_config('request.jwt.claim.sub', coalesce(a.uid::text, ''), true);
      perform set_config('request.jwt.claims',
        case when a.uid is null then '' else json_build_object('sub', a.uid, 'role', 'authenticated')::text end, true);
      if auth.uid() is distinct from a.uid then
        raise exception 'CONTROL: the impersonation of the % did not take', a.label;
      end if;
      raise exception using errcode = 'P0R01', message = concat_ws('|',
        coalesce(public.can_manage_family(fam)::text, 'null'), coalesce(public.is_family_admin(fam)::text, 'null'),
        coalesce(public.is_family_member(fam)::text, 'null'), coalesce(public.family_role(fam)::text, 'null'),
        coalesce(public.social_role_for(fam)::text, 'null'), coalesce(public.social_has_permission(fam, 'publish_posts')::text, 'null'));
    exception
      when sqlstate 'P0R01' then got := sqlerrm;
      when others then
        if sqlerrm like 'CONTROL:%' then raise; end if;
        got := 'error ' || sqlstate || ': ' || sqlerrm;
    end;
    -- The two functions below that take the caller's own member id are given
    -- this actor's: the gate must refuse a non-manager's own row, not a
    -- mismatched one.
    actor_member := case a.label
      when 'parent' then parent_member
      when 'adult' then '00000000-0000-4000-8a11-0000000000d2'
      when 'teen' then '00000000-0000-4000-8a11-0000000000d3'
      when 'child' then '00000000-0000-4000-8a11-0000000000d4'
      when 'caregiver' then '00000000-0000-4000-8a11-0000000000d5'
      when 'guest' then '00000000-0000-4000-8a11-0000000000d6'
      when 'removed parent' then '00000000-0000-4000-8a11-0000000000d7'
      when 'outsider parent' then outsider_member
    end;
    if got is distinct from concat_ws('|', a.manages::text, a.admin::text, a.member::text, coalesce(a.role, 'null'),
                                      coalesce(a.social, 'null'), a.publishes::text) then
      failures := array_append(failures, format('%s: can_manage_family|is_family_admin|is_family_member|family_role|social_role_for|social_has_permission(publish_posts) answered %s, expected %s',
        a.label, got, concat_ws('|', a.manages::text, a.admin::text, a.member::text, coalesce(a.role, 'null'), coalesce(a.social, 'null'), a.publishes::text)));
    end if;

    for c in select * from (values
        ('economy_decide_redemption',  format('select public.economy_decide_redemption(%L::uuid, false, %L)::text', '00000000-0000-4000-8a11-0000000000e2', 'role matrix'), null::text),
        ('guardian_review_suggestion', format('select public.guardian_review_suggestion(%L::uuid, %L, null)::text', '00000000-0000-4000-8a11-0000000000e3', 'dismissed'), null::text),
        ('invest_decide_order',        format('select public.invest_decide_order(%L::uuid, false)::text', '00000000-0000-4000-8a11-0000000000e5'), null::text),
        ('wallet_approve_gift',        format('select public.wallet_approve_gift(%L::uuid, %L::uuid, %L::uuid)::text', fam, nowhere, a.uid), null::text),
        ('wallet_debit_spend_bucket',  format('select public.wallet_debit_spend_bucket(%L::uuid, %L::uuid, 100, %L::wallet_txn_type, %L, %L::uuid, false, null, null, null, %L::jsonb)::text', fam, wallet, 'adjustment', 'role matrix', a.uid, '{}'), null::text),
        ('wallet_decide_allowance',    format('select public.wallet_decide_allowance(%L::uuid, %L::uuid, %L, null, %L::uuid)::text', fam, nowhere, 'rejected', a.uid), null::text),
        ('wallet_decide_spend',        format('select public.wallet_decide_spend(%L::uuid, %L::uuid, %L, null, %L::uuid)::text', fam, nowhere, 'rejected', a.uid), null::text),
        ('wallet_fund_goal',           format('select public.wallet_fund_goal(%L::uuid, %L::uuid, 100, %L::uuid)::text', fam, nowhere, a.uid), null::text),
        ('wallet_transfer',            format('select public.wallet_transfer(%L::uuid, %L::uuid, %L::uuid, 100, %L, %L::uuid)::text', fam, wallet, nowhere, 'role matrix', a.uid), null::text),
        -- These two raise rather than answer, with their own 42501 sentence.
        ('move_recalculate_date',      format('select public.move_recalculate_date(%L::uuid, %L::uuid, %L::uuid, current_date)::text', fam, nowhere, actor_member), '42501: authorization'),
        ('vacation_import_confirmation', format('select public.vacation_import_confirmation(%L::uuid, %L::uuid, %L::uuid, %L::jsonb, %L::jsonb)::text', fam, nowhere, actor_member, '{}', '{}'), '42501: An %member%required')
      ) as x(fn, sql, gate_raise) loop
      r := null; raised := null;
      begin
        perform set_config('role', a.pg_role, true);
        perform set_config('request.jwt.claim.sub', coalesce(a.uid::text, ''), true);
        perform set_config('request.jwt.claims',
          case when a.uid is null then '' else json_build_object('sub', a.uid, 'role', 'authenticated')::text end, true);
        execute c.sql into r;
        raise exception using errcode = 'P0R01', message = coalesce(r, 'null');
      exception
        when sqlstate 'P0R01' then r := sqlerrm;
        when others then raised := sqlstate || ': ' || sqlerrm;
      end;
      calls := calls + 1;
      -- The function's OWN refusal: an answer of 'forbidden'/'unauthenticated',
      -- or, for the two that raise, their own 42501 sentence.
      own_refusal := (raised is null and coalesce(r::jsonb->>'reason', '') in ('forbidden', 'unauthenticated'))
        or (c.gate_raise is not null and raised like c.gate_raise);
      -- Past the gate: any answer that is not a refusal, or, for the two that
      -- raise, any error that is not a 42501 (they fail later on the unknown
      -- move or the empty source).
      admitted := not own_refusal
        and (raised is null or (c.gate_raise is not null and raised not like '42501:%'));
      if a.manages and not admitted then
        failures := array_append(failures, format('the %s was refused by %s (%s)', a.label, c.fn, coalesce(raised, r)));
      elsif not a.manages and admitted then
        failures := array_append(failures, format('the %s got past the gate of %s (%s)', a.label, c.fn, coalesce(raised, r)));
      elsif not a.manages and not own_refusal and not (a.pg_role = 'anon' and raised like '42501:%') then
        -- A signed-in non-manager must meet the function's OWN refusal. A
        -- 42501 from somewhere deeper (economy's and invest's decision-guard
        -- triggers) is a second layer holding, and it would hide a gate that
        -- is not there. Only anon, which holds no EXECUTE on the wallet
        -- functions, may be stopped by the grant.
        failures := array_append(failures, format('the %s was stopped by %s, but not by its own gate (%s), which would hide a missing gate', a.label, c.fn, raised));
      end if;
    end loop;
  end loop;

  if calls <> 99 then
    failures := array_append(failures, format('CONTROL: %s of 99 calls were made', calls));
  end if;

  -- MUTATION CONTROLS: loosen one row-first and one gate-first gate to
  -- is_family_member; the child must then get past each.
  for c in select * from (values
      -- Not economy_decide_redemption: its decision-guard trigger refuses a
      -- non-manager's status change on its own (42501), a second layer that
      -- holds even with the RPC's gate loosened. guardian_suggestions has none.
      ('public.guardian_review_suggestion(uuid,text,text)', 'can_manage_family(v_suggestion.family_id)', 'is_family_member(v_suggestion.family_id)',
       format('select public.guardian_review_suggestion(%L::uuid, %L, null)::text', '00000000-0000-4000-8a11-0000000000e3', 'dismissed')),
      ('public.wallet_transfer(uuid,uuid,uuid,bigint,text,uuid)', 'can_manage_family(p_family_id)', 'is_family_member(p_family_id)',
       format('select public.wallet_transfer(%L::uuid, %L::uuid, %L::uuid, 100, %L, %L::uuid)::text', fam, wallet, nowhere, 'mutation', '00000000-0000-4000-8a11-0000000000a4'))
    ) as x(sig, gate, loose, sql) loop
    original_def := pg_get_functiondef(c.sig::regprocedure);
    if position(c.gate in original_def) = 0 then
      failures := array_append(failures, format('PROBE DRIFT: %s no longer contains %s, so its mutation control measures nothing', c.sig, c.gate));
      continue;
    end if;
    execute replace(original_def, c.gate, c.loose);
    r := null; raised := null;
    begin
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8a11-0000000000a4', true);
      perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8a11-0000000000a4', 'role', 'authenticated')::text, true);
      execute c.sql into r;
      raise exception using errcode = 'P0R01', message = coalesce(r, 'null');
    exception
      when sqlstate 'P0R01' then r := sqlerrm;
      when others then raised := sqlstate || ': ' || sqlerrm;
    end;
    execute original_def;
    if raised is not null or coalesce(r::jsonb->>'reason', '') in ('forbidden', 'unauthenticated') then
      failures := array_append(failures, format('MUTATION CONTROL: with %s loosened to is_family_member the child was still refused (%s), so this matrix cannot see a weakened gate', c.sig, coalesce(raised, r)));
    end if;
  end loop;

  if array_length(failures, 1) is not null then
    raise exception E'a manager-only RPC answers the wrong role:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'every-role-through-the-manager-rpcs: OK (99 calls: the parent and the adult got past the gate of all eleven manager RPCs; the teen, child, caregiver, guest, a removed parent, a parent of another family and anon were refused at it; can_manage_family, is_family_admin, is_family_member, family_role, social_role_for and social_has_permission(publish_posts) answered as designed for all nine actors; mutation controls: with guardian_review_suggestion''s and wallet_transfer''s gates loosened to is_family_member the child got past both)';
end $$;

rollback;
