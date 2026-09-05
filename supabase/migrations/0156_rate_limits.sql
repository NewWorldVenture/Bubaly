-- Bubaly :: 0156 Durable rate limits (AI-2)
-- ----------------------------------------------------------------------------
-- The public, model-backed endpoints (e.g. /api/ai/gift) were rate-limited by an
-- in-memory fixed-window map — per serverless INSTANCE, so N cold instances = N×
-- the intended limit. This adds a shared Postgres-backed fixed-window counter so
-- the limit holds across instances.
--
--   • rate_limits          — one row per (bucket_key, window_start)
--   • rate_limit_hit(...)   — atomic increment; returns allowed + retry_after
--
-- Service-role only (RLS on, no policies). The RPC is SECURITY DEFINER so the
-- server can call it regardless. Additive + idempotent.

create table if not exists public.rate_limits (
  bucket_key   text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (bucket_key, window_start)
);
create index if not exists idx_rate_limits_window on public.rate_limits(window_start);

alter table public.rate_limits enable row level security;
-- No policies: only the service role (which bypasses RLS) touches this table.

-- Atomic fixed-window hit. Buckets align to p_window_seconds boundaries so every
-- instance agrees on the current window. Returns whether this hit is allowed and,
-- if not, how many seconds until the window resets.
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns table(allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (bucket_key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set count = public.rate_limits.count + 1, updated_at = now()
  returning count into v_count;

  if v_count > p_limit then
    return query select false,
      greatest(1, ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds)) - now())))::integer;
  else
    return query select true, 0;
  end if;
end;
$$;

grant execute on function public.rate_limit_hit(text, integer, integer) to anon, authenticated, service_role;

-- Opportunistic cleanup helper (a cron can call it; rows are tiny + self-expiring
-- by window, so this is just housekeeping).
create or replace function public.rate_limit_prune()
returns void language sql security definer set search_path = public as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;
