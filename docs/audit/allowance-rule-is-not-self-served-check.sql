-- ── A child may not set the amount of their own allowance ───────────────────
--
-- `allowance_rules` carries `child_wallet_id`, `amount_cents`, `cadence` and
-- `next_run_on`; the wallet allowance cron reads the rules that are due and
-- credits the named wallet. Before 0319 its only policy was
-- `for all to authenticated using (is_family_member(family_id))`, so the rule
-- deciding who may set the amount asked only whether the caller was in the
-- household — and the child being paid is in the household.
--
-- Every write path in app/(app)/wallet/actions.ts gates on `isManager`, but a
-- server action is no boundary against a JWT holder: a PATCH to
-- /rest/v1/allowance_rules never passes through app/ at all.
--
-- Reproduced before the repair, as the child:
--   update public.allowance_rules set amount_cents = 100000, next_run_on = current_date;
--   -> UPDATE 1   ($5.00/week became $1,000.00, scheduled for today)
--
-- Proves, in both directions:
--   1. a child can neither raise the amount, nor pull the run date forward, nor
--      insert a fresh rule paying their own wallet, nor delete one;
--   2. a manager still can — a guard that refuses everyone is not a boundary;
--   3. a child can still READ their rule, deliberately: "you get $5 on Fridays"
--      is the feature. If that changes, this line fails on purpose;
--   4. UPDATE pins `family_id` on both sides, so a manager cannot move a rule
--      into another household;
--   5. a negative control restores the permissive policy and requires the
--      child's raise to succeed again — a check never shown to fail is
--      decoration.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/allowance-rule-is-not-self-served-check.sql

\set FA '00000000-0000-4000-8000-00000000af0f'
\set FB '00000000-0000-4000-8000-00000000af1f'
\set UP '00000000-0000-4000-8000-00000000af01'
\set UK '00000000-0000-4000-8000-00000000af02'
\set UO '00000000-0000-4000-8000-00000000af06'

begin;

insert into auth.users (id,email) values (:'UP','af-parent@example.com') on conflict do nothing;
insert into auth.users (id,email) values (:'UK','af-kid@example.com')    on conflict do nothing;
insert into auth.users (id,email) values (:'UO','af-other@example.com')  on conflict do nothing;

insert into public.families (id,name,created_by) values (:'FA','Allowance House',:'UP') on conflict do nothing;
insert into public.families (id,name,created_by) values (:'FB','Other House',:'UO')     on conflict do nothing;
-- The creator is provisioned as a manager by on_family_created; make sure of it
-- rather than assuming, because a seed whose roles are wrong proves nothing.
update public.family_members set role='parent' where family_id=:'FA' and user_id=:'UP';
update public.family_members set role='parent' where family_id=:'FB' and user_id=:'UO';

insert into public.family_members (id,family_id,user_id,display_name,role,is_active)
  values ('00000000-0000-4000-8000-00000000af03',:'FA',:'UK','Kid','child',true) on conflict do nothing;
insert into public.child_wallets (id,family_id,member_id)
  values ('00000000-0000-4000-8000-00000000af04',:'FA','00000000-0000-4000-8000-00000000af03');
insert into public.allowance_rules (id,family_id,child_wallet_id,amount_cents,cadence,is_active,next_run_on,created_by)
  values ('00000000-0000-4000-8000-00000000af05',:'FA','00000000-0000-4000-8000-00000000af04',500,'weekly',true,current_date + 7,:'UP');

grant select, insert, update, delete on public.allowance_rules to authenticated;

do $$
declare
  n int;
  cents bigint;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000af0f';
  other_fam constant uuid := '00000000-0000-4000-8000-00000000af1f';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000af01';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000af02';
  wallet    constant uuid := '00000000-0000-4000-8000-00000000af04';
  rule      constant uuid := '00000000-0000-4000-8000-00000000af05';
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- The move: raise the amount and pull the run date to today.
  update public.allowance_rules set amount_cents = 100000, next_run_on = current_date where id = rule;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child REWROTE %s allowance rule(s) — self-dealing against the row that pays them', n));
  end if;

  -- Planting a second rule aimed at their own wallet is the same theft twice.
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on, created_by)
      values (fam, wallet, 250000, 'weekly', true, current_date, kid_u);
    failures := array_append(failures, 'a child INSERTED an allowance rule paying their own wallet');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s INSERT reached a constraint, so RLS did not refuse it');
  end;

  delete from public.allowance_rules where id = rule;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s allowance rule(s)', n)); end if;

  -- Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.allowance_rules where id = rule;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ their allowance rule — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── As the manager: the positive control ────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  update public.allowance_rules set amount_cents = 700 where id = rule;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not change an allowance — the guard refuses everyone'); end if;

  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on, created_by)
      values (fam, wallet, 300, 'monthly', true, current_date + 30, parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not create an allowance rule');
  end;

  -- ── WITH CHECK: a manager may not relocate a rule ───────────────────────
  begin
    update public.allowance_rules set family_id = other_fam where id = rule;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED an allowance rule into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  perform set_config('role','postgres', true);
  drop policy if exists allowance_rules_update on public.allowance_rules;
  execute 'create policy "Members manage allowance_rules" on public.allowance_rules '
       || 'for all to authenticated using (is_family_member(family_id)) with check (is_family_member(family_id))';

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  update public.allowance_rules set amount_cents = 100000 where id = rule;
  get diagnostics n = row_count;
  select amount_cents into cents from public.allowance_rules where id = rule;
  if n = 0 or cents <> 100000 then
    failures := array_append(failures, 'with the permissive policy restored the child STILL could not raise their allowance — this probe is decoration, not a boundary');
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'allowance rules are self-servable:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'allowance-rule-is-not-self-served: OK (child blocked, manager allowed, family_id pinned, negative control saw the defect)';
end $$;

rollback;
