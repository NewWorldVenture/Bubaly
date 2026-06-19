-- FamilyOS :: 0003 functions + triggers

-- ----- RLS helper functions (SECURITY DEFINER bypasses RLS to avoid recursion) -----

create or replace function public.is_family_member(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and is_active
  );
$$;

create or replace function public.family_role(p_family_id uuid)
returns public.member_role language sql security definer stable set search_path = public as $$
  select role from public.family_members
  where family_id = p_family_id and user_id = auth.uid()
  order by case role when 'parent' then 0 when 'adult' then 1 else 2 end
  limit 1;
$$;

-- Household managers (can manage shared data + approve chores).
create or replace function public.can_manage_family(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid()
      and role in ('parent','adult') and is_active
  );
$$;

-- Full admin (parent only) for billing/family deletion.
create or replace function public.is_family_admin(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid()
      and role = 'parent' and is_active
  );
$$;

-- ----- updated_at maintenance -----
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ----- new auth user -> profile + preferences -----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----- new family -> creator becomes parent member + trial subscription -----
create or replace function public.handle_new_family()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is not null then
    insert into public.family_members (family_id, user_id, role, display_name)
    values (new.id, new.created_by, 'parent',
            coalesce((select full_name from public.profiles where id = new.created_by), 'Parent'))
    on conflict (family_id, user_id) do nothing;
  end if;
  insert into public.subscriptions (family_id, plan, status, current_period_end)
  values (new.id, 'free', 'trialing', now() + interval '14 days');
  return new;
end; $$;

drop trigger if exists on_family_created on public.families;
create trigger on_family_created
  after insert on public.families
  for each row execute function public.handle_new_family();

-- ----- attach updated_at triggers to every table that has the column -----
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
    group by table_name
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
