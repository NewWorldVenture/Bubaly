-- Disposable ACL fixture. These functions are harmless stubs, not wallet/bid code.
do $$ begin
  if current_database() <> 'bubaly_acl_fixture_20261008' then
    raise exception 'Refusing a database other than the isolated ACL fixture';
  end if;
end $$;
create role anon;
create role authenticated;
create role service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges grant execute on functions to anon, authenticated;
create function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text)
returns boolean language sql security definer set search_path=public as $$ select false $$;
create function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint)
returns jsonb language sql security definer set search_path=public as $$ select '{"fixture":true}'::jsonb $$;
