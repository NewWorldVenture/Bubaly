-- ============================================================================
-- 0187 · Marketplace negotiation integrity guards.
--
-- 0186 moved negotiation writes into locked SECURITY DEFINER RPCs. This
-- additive repair makes the data contract enforceable even if a future RPC,
-- service-role seed, or migration bypasses the current application checks:
--   · a family cannot negotiate with itself;
--   · money values and messages stay bounded;
--   · offer/counter/accept rounds remain below the asking price.
--
-- Additive + idempotent. Apply after 0186.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.marketplace_negotiations'::regclass
      and conname = 'marketplace_negotiations_distinct_families'
  ) then
    alter table public.marketplace_negotiations
      add constraint marketplace_negotiations_distinct_families
      check (family_id <> buyer_family_id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.marketplace_negotiations'::regclass
      and conname = 'marketplace_negotiations_amount_bound'
  ) then
    alter table public.marketplace_negotiations
      add constraint marketplace_negotiations_amount_bound
      check (current_amount_cents <= 100000000000) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.marketplace_negotiation_rounds'::regclass
      and conname = 'marketplace_negotiation_rounds_amount_bound'
  ) then
    alter table public.marketplace_negotiation_rounds
      add constraint marketplace_negotiation_rounds_amount_bound
      check (amount_cents is null or (amount_cents > 0 and amount_cents <= 100000000000)) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.marketplace_negotiation_rounds'::regclass
      and conname = 'marketplace_negotiation_rounds_message_bound'
  ) then
    alter table public.marketplace_negotiation_rounds
      add constraint marketplace_negotiation_rounds_message_bound
      check (message is null or length(message) <= 500) not valid;
  end if;
end $$;

create or replace function public.validate_marketplace_negotiation_round()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ask bigint;
begin
  if new.kind in ('offer', 'counter', 'accept') and new.amount_cents is null then
    raise exception 'Negotiation amount is required';
  end if;

  if new.kind in ('offer', 'counter', 'accept') then
    select price_cents into v_ask
    from public.marketplace_listings
    where id = new.listing_id;
    if v_ask is not null and v_ask > 0 and new.amount_cents >= v_ask then
      raise exception 'Negotiation amount must be below the asking price';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_marketplace_negotiation_round
  on public.marketplace_negotiation_rounds;
create trigger trg_validate_marketplace_negotiation_round
  before insert or update on public.marketplace_negotiation_rounds
  for each row execute function public.validate_marketplace_negotiation_round();

revoke all on function public.validate_marketplace_negotiation_round() from public;
