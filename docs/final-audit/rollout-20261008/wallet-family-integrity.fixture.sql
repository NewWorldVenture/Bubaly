-- Synthetic structural fixture only. No Auth/RLS, balances, payouts or real records.
-- Run setup in a fresh disposable database with this exact fixture name.
do $$ begin
  if current_database() <> 'bubaly_reference_fixture_20261008' then
    raise exception 'Refusing a database other than the isolated fixture';
  end if;
end $$;
create table public.child_wallets (id uuid primary key, family_id uuid not null);
create table public.allowance_rules (id uuid primary key, family_id uuid not null, child_wallet_id uuid not null, note text);
create table public.invest_orders (id uuid primary key, family_id uuid not null, child_wallet_id uuid not null, note text);
insert into public.child_wallets values
  (md5('wallet-a')::uuid, md5('family-a')::uuid),
  (md5('wallet-b')::uuid, md5('family-b')::uuid);
insert into public.allowance_rules values (md5('old-allowance')::uuid, md5('family-a')::uuid, md5('wallet-b')::uuid, 'historical fixture');
insert into public.invest_orders values (md5('old-order')::uuid, md5('family-a')::uuid, md5('wallet-b')::uuid, 'historical fixture');
