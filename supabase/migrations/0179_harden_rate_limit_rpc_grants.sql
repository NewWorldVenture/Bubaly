-- Bubaly :: 0179 - Harden durable limiter RPC privileges
--
-- 0156 granted the SECURITY DEFINER limiter RPC to anon and left the prune RPC
-- inheriting PostgreSQL's default PUBLIC execute privilege. A caller could then
-- increment arbitrary buckets or clear the shared limiter directly, bypassing
-- the application guards. Authenticated application calls remain supported, but
-- their bucket key must include their own auth.uid(). Public ingestion routes use
-- the service-role client and are unaffected.

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon;
grant execute on function public.rate_limit_hit(text, integer, integer) to authenticated, service_role;

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
  -- Authenticated callers may only reserve their own namespace. Service-role
  -- calls (including anonymous public routes behind server code) have no auth.uid.
  if auth.uid() is not null
     and p_key !~ ('(^|:)' || auth.uid()::text || '(:|$)') then
    raise exception 'rate limit key must be scoped to the authenticated caller';
  end if;

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

revoke execute on function public.rate_limit_prune() from public, anon, authenticated;
grant execute on function public.rate_limit_prune() to service_role;
