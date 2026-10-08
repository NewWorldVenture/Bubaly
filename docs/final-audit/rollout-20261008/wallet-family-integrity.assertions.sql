-- After the candidate DDL, in the same disposable structural fixture only.
do $$ begin
  if current_database() <> 'bubaly_reference_fixture_20261008' then
    raise exception 'Refusing a database other than the isolated fixture';
  end if;
  if (select count(*) from public.allowance_rules) <> 1 or
     (select count(*) from public.invest_orders) <> 1 then
    raise exception 'Candidate changed historical rows';
  end if;
  if to_regclass('public.allowance_rules_child_wallet_family_idx') is null
     or to_regclass('public.invest_orders_child_wallet_family_idx') is null then
    raise exception 'Missing child reference lookup indexes';
  end if;
  if (select count(*) from pg_constraint where conname in
      ('allowance_rules_wallet_family_fkey', 'invest_orders_wallet_family_fkey') and not convalidated) <> 2 then
    raise exception 'Expected two explicitly unvalidated constraints';
  end if;
end $$;

insert into public.allowance_rules values (md5('new-allowance')::uuid, md5('family-a')::uuid, md5('wallet-a')::uuid, 'valid fixture');
insert into public.invest_orders values (md5('new-order')::uuid, md5('family-a')::uuid, md5('wallet-a')::uuid, 'valid fixture');

do $$ begin
  begin
    insert into public.allowance_rules values (md5('bad-allowance')::uuid, md5('family-a')::uuid, md5('wallet-b')::uuid, null);
    raise exception 'Accepted a cross-family allowance';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.invest_orders values (md5('bad-order')::uuid, md5('family-a')::uuid, md5('wallet-b')::uuid, null);
    raise exception 'Accepted a cross-family order';
  exception when foreign_key_violation then null; end;
  begin
    update public.allowance_rules set child_wallet_id=md5('wallet-b')::uuid where id=md5('new-allowance')::uuid;
    raise exception 'Accepted a cross-family reference change';
  exception when foreign_key_violation then null; end;
  begin
    update public.child_wallets set family_id=md5('family-b')::uuid where id=md5('wallet-a')::uuid;
    raise exception 'Accepted a parent family change invalidating existing references';
  exception when foreign_key_violation then null; end;
  begin
    alter table public.allowance_rules validate constraint allowance_rules_wallet_family_fkey;
    raise exception 'Validated inconsistent historical allowances';
  exception when foreign_key_violation then null; end;
  begin
    alter table public.invest_orders validate constraint invest_orders_wallet_family_fkey;
    raise exception 'Validated inconsistent historical orders';
  exception when foreign_key_violation then null; end;
end $$;

-- NOT VALID does not repair or force revalidation of unchanged historical keys.
update public.allowance_rules set note='unrelated update' where id=md5('old-allowance')::uuid;
update public.invest_orders set note='unrelated update' where id=md5('old-order')::uuid;
do $$ begin
  if (select count(*) from public.allowance_rules) <> 2 or
     (select count(*) from public.invest_orders) <> 2 then
    raise exception 'Unexpected fixture row count';
  end if;
  if not exists(select 1 from public.allowance_rules a join public.child_wallets w on w.id=a.child_wallet_id where a.family_id<>w.family_id)
     or not exists(select 1 from public.invest_orders o join public.child_wallets w on w.id=o.child_wallet_id where o.family_id<>w.family_id) then
    raise exception 'Historical mismatches were unexpectedly changed';
  end if;
end $$;
