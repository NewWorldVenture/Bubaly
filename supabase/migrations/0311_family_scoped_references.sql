-- Bubaly :: 0311 - a row's references must live in the row's own family
--
-- Every family-scoped INSERT policy in this schema checks the row's OWN
-- `family_id` and nothing else. The foreign keys beside it name `parent(id)`
-- alone, because that is the parent's primary key. So a member may write a row
-- carrying THEIR family_id and a reference into SOMEBODY ELSE'S family, and
-- both the policy and the constraint are satisfied.
--
-- The repo already knows the class. lib/services/tasks/index.ts guards one
-- instance by hand, in application code:
--
--   "Confirm the chore belongs to this family before writing an assignment
--    that would otherwise carry a foreign family's chore_id under our
--    family_id."
--
-- Measured on a replayed database with every migration applied, acting as a
-- manager of family A who is not a member of family B, all three landed:
--
--   * a chore_assignment under A pointing at B's chore              (1 row)
--   * a chore_assignment under A assigned to B's member             (1 row)
--   * an allowance_rule under A pointing at B's child_wallet        (1 row)
--
-- Reads still hold — A cannot SELECT B's chore, so this is not a read leak.
-- What it reaches is the code that ACTS on the reference.
--
-- ── why allowance_rules is the one that bites ───────────────────────────────
--
-- The nightly cron credits `rule.child_wallet_id`. `creditChildWallet` resolves
-- buckets by (family_id, child_wallet_id), so a foreign wallet matches none and
-- the credit fails "not fully provisioned" — it does NOT pay another family.
-- The damage is what the route then did with that failure: it threw, the outer
-- catch returned 500, and because the rollback restores `next_run_on` the same
-- rule was due again the next night and threw at the same point. The rules are
-- read `.order('id')`, so every rule after it was never reached. One row
-- stopped allowances for every family after it, permanently.
--
-- That half is fixed in the route (degrade-but-log, the contract the repo's
-- other four batch crons already follow, now locked by
-- tests/cron-batch-failure-status.test.ts and a behavioural test). This
-- migration closes the door that let the row exist, so the cron is not the only
-- thing standing between a mistyped wallet id and a silent platform outage.
--
-- ── scope ──────────────────────────────────────────────────────────────────
--
-- Deliberately narrow: the three references measured above, guarded by trigger
-- rather than by composite foreign keys. A composite key would need a
-- `(family_id, id)` unique constraint on every parent table and a rewrite of
-- 454 constraints; that is a schema migration for a quiet weekend with the
-- ledger healthy, not a boundary fix. The shared helper below is written so the
-- next reference costs one line, which is the thing 0275's header asks for —
-- "by shape rather than by name".
--
-- The trusted server (service role, or a migration or seed with no session) is
-- exempt, as elsewhere in this series: backfills legitimately move rows.

create or replace function public.reference_shares_family()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $guard$
declare
  ref_col   text := tg_argv[0];
  ref_table text := tg_argv[1];
  ref_id    uuid;
  ref_fam   uuid;
begin
  execute format('select ($1).%I', ref_col) into ref_id using new;
  if ref_id is null then
    return new;
  end if;

  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  execute format('select family_id from public.%I where id = $1', ref_table)
    into ref_fam using ref_id;

  -- A reference that resolves to nothing is the foreign key's business, not
  -- this trigger's; let the constraint raise its own error.
  if ref_fam is null then
    return new;
  end if;

  if ref_fam is distinct from new.family_id then
    raise exception
      '%.% points at a row in another family', tg_table_name, ref_col
      using errcode = '42501';
  end if;

  return new;
end;
$guard$;

comment on function public.reference_shares_family() is
  'A family-scoped row may not reference a row belonging to a different family. Every INSERT policy here checks only the row''s own family_id, and the foreign keys name parent(id) alone, so without this a member could write their family_id beside somebody else''s reference. Takes (column, parent table) as trigger arguments.';

-- ── wiring ──────────────────────────────────────────────────────────────────
--
-- One row per guarded reference. Each is VALIDATED before its trigger is
-- created, because the failure mode of a mis-wired one is nasty and quiet: the
-- helper early-returns for the trusted server, so a migration replay (no JWT,
-- `auth.uid()` null) installs it happily and every AUTHENTICATED write to that
-- table then fails with 42703 in production. Measured — that is exactly what a
-- parent table without a `family_id` column does. Validating here turns a
-- production-time error into a replay-time one, and keeps "the next reference
-- costs one line" honest.
do $$
declare
  w record;
begin
  for w in
    select *
    from (values
      ('allowance_rules',   'child_wallet_id', 'child_wallets'),
      ('chore_assignments', 'chore_id',        'chores'),
      ('chore_assignments', 'member_id',       'family_members')
    ) as v(child, col, parent)
  loop
    -- A table this database has not reached yet is not an error; skip it, the
    -- way the rest of this series does.
    if to_regclass('public.' || w.child) is null or to_regclass('public.' || w.parent) is null then
      continue;
    end if;

    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = 'family_id') then
      raise exception 'reference_shares_family: %.family_id does not exist', w.child;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = w.col) then
      raise exception 'reference_shares_family: %.% does not exist', w.child, w.col;
    end if;
    -- The one that fails silently at replay and loudly in production.
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.parent and column_name = 'family_id') then
      raise exception
        'reference_shares_family: parent %.family_id does not exist, so the guard on %.% would raise 42703 on every authenticated write',
        w.parent, w.child, w.col;
    end if;

    execute format('drop trigger if exists %I on public.%I',
                   'trg_' || w.child || '_' || w.col || '_family', w.child);
    execute format(
      'create trigger %I before insert or update of %I, family_id on public.%I '
      || 'for each row execute function public.reference_shares_family(%L, %L)',
      'trg_' || w.child || '_' || w.col || '_family', w.col, w.child, w.col, w.parent);
  end loop;
end
$$;
