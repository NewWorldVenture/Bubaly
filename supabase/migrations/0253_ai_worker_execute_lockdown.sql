-- 0253: Supabase default privileges grant EXECUTE directly to client roles.
-- Revoking PUBLIC alone in 0250 does not remove those direct grants.
-- Only the trusted server worker may claim or mutate the global AI run queue.
revoke all on function public.claim_ai_runs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_runs(integer, integer) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.claim_ai_runs(integer,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.claim_ai_runs(integer,integer)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.claim_ai_runs(integer,integer)', 'EXECUTE')
  then
    raise exception 'AI worker RPC permissions are incorrect';
  end if;
end $$;
