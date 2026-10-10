select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
 pg_get_function_result(p.oid) as returns, p.prosecdef as security_definer, p.proconfig as settings,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 pg_get_functiondef(p.oid) as definition
from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
and p.proname in ('wallet_reserve_card_auth','marketplace_place_bid_unchecked',
'claim_marketing_generation_jobs','enqueue_marketing_page_generation','rate_limit_hit','__seed_existing_count')
order by p.proname,arguments;
