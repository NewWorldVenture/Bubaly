-- Bubaly :: 0005 RPCs (callable from client via supabase.rpc)

-- Accept an invite by token: joins the caller to the family with the invited role.
-- SECURITY DEFINER because the new member is not yet a manager of the family.
create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite public.invites;
  v_name   text;
begin
  select * into v_invite from public.invites
  where token = p_token and status = 'pending' and expires_at > now()
  for update;

  if not found then
    raise exception 'Invite is invalid or expired';
  end if;

  if lower(v_invite.email) <> lower(coalesce(auth.jwt()->>'email','')) then
    raise exception 'This invite was issued to a different email';
  end if;

  select coalesce(full_name, display_name, email) into v_name
  from public.profiles where id = auth.uid();

  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_invite.family_id, auth.uid(), v_invite.role, coalesce(v_name,'Member'))
  on conflict (family_id, user_id) do update set is_active = true;

  update public.invites
    set status = 'accepted', accepted_by = auth.uid(), updated_at = now()
  where id = v_invite.id;

  update public.user_preferences
    set active_family_id = v_invite.family_id
  where user_id = auth.uid() and active_family_id is null;

  return v_invite.family_id;
end; $$;

-- Build/refresh a grocery list from a date range of the meal plan.
create or replace function public.grocery_from_meal_plan(
  p_family_id uuid, p_from date, p_to date, p_list_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_list_id uuid := p_list_id;
  v_ing jsonb;
begin
  if not public.is_family_member(p_family_id) then
    raise exception 'Not a member of this family';
  end if;

  if v_list_id is null then
    insert into public.grocery_lists (family_id, name, created_by)
    values (p_family_id, 'From meal plan ' || p_from || '–' || p_to, auth.uid())
    returning id into v_list_id;
  end if;

  for v_ing in
    select jsonb_array_elements(m.ingredients) as ing
    from public.meal_plans mp
    join public.meals m on m.id = mp.meal_id
    where mp.family_id = p_family_id
      and mp.plan_date between p_from and p_to
      and m.ingredients is not null
  loop
    insert into public.grocery_items (family_id, list_id, name, quantity, created_by)
    values (p_family_id, v_list_id,
            coalesce(v_ing->>'name','item'), v_ing->>'qty', auth.uid());
  end loop;

  return v_list_id;
end; $$;

grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.grocery_from_meal_plan(uuid,date,date,uuid) to authenticated;
