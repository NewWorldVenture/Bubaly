select clock_timestamp() as observed_at,
 (select count(*) from public.invest_orders) as investment_orders,
 (select count(*) from public.invest_orders where status='pending') as pending_orders,
 (select count(*) from public.invest_orders where amount_cents is distinct from (shares*price_cents)::bigint) as inconsistent_order_amounts,
 (select count(*) from public.invest_orders where status='pending' and amount_cents is distinct from (shares*price_cents)::bigint) as inconsistent_pending_amounts,
 (select count(*) from public.invest_orders o join public.child_wallets w on w.id=o.child_wallet_id where o.family_id is distinct from w.family_id) as cross_family_order_wallets,
 (select count(*) from public.allowance_rules a join public.child_wallets w on w.id=a.child_wallet_id where a.family_id is distinct from w.family_id) as cross_family_allowance_wallets;
