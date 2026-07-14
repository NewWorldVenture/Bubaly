-- FamilyOS :: 0199 - atomic Marketplace hand-off completion
--
-- Completing a pickup must advance both the hand-off and its order together.
-- Keep the code check and both status changes in one member-authorized transaction.

create or replace function public.marketplace_complete_handoff(
  p_order_id uuid,
  p_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_handoff record;
  v_code text;
  v_expected text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_order_id is null or length(coalesce(p_code, '')) > 80 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select id, family_id, status
    into v_order
    from public.marketplace_orders
   where id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;
  if not public.is_family_member(v_order.family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_order.status not in ('confirmed', 'active', 'returned') then
    return jsonb_build_object('ok', false, 'reason', 'order_not_open');
  end if;

  select id, status, confirm_code
    into v_handoff
    from public.marketplace_handoffs
   where order_id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'handoff_not_found');
  end if;
  if v_handoff.status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'handoff_not_ready');
  end if;

  v_code := regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  v_expected := regexp_replace(upper(coalesce(v_handoff.confirm_code, '')), '[^A-Z0-9]', '', 'g');
  if length(v_code) = 0 or v_code <> v_expected then
    return jsonb_build_object('ok', false, 'reason', 'code_mismatch');
  end if;

  update public.marketplace_handoffs
     set status = 'completed', completed_at = now()
   where id = v_handoff.id;

  update public.marketplace_orders
     set status = 'completed'
   where id = v_order.id
     and status in ('confirmed', 'active', 'returned');
  if not found then
    raise exception 'Marketplace order changed while completing handoff';
  end if;

  return jsonb_build_object('ok', true, 'status', 'completed');
end;
$$;

revoke all on function public.marketplace_complete_handoff(uuid, text) from public;
grant execute on function public.marketplace_complete_handoff(uuid, text) to authenticated;
