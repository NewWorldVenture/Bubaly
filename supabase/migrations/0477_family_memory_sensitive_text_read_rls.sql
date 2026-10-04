-- A direct authenticated Data API read used to expose sensitive memory text
-- whenever a family member put it in an ordinary category, or in a playbook
-- suggestion's evidence. App-level filtering is not an authorization boundary:
-- the same user's Supabase token can select these tables directly.
--
-- RLS filters rows rather than masking individual columns. Preserve ordinary
-- family memories and suggestion cards for the whole household; hide an entire
-- sensitive row from non-managers, while parent/adult managers retain review
-- access. This is SELECT-only and does not change memory creation, dismissal,
-- or update behavior.

create or replace function public.family_memory_text_is_sensitive(
  p_category text,
  p_label text,
  p_value text,
  p_context text
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select coalesce(p_category in ('medical', 'account'), false)
    or pg_catalog.concat_ws(' ', p_label, p_value, p_context) ~*
      $pattern$\y(ssn|social security|passport (no|number)|password|passcode|pin|bank|routing|account number|card number|credit card|iban|allerg(y|ies|ic)|diagnos|prescription|medication|therap|hiv|pregnan|salary)\y$pattern$;
$function$;

comment on function public.family_memory_text_is_sensitive(text, text, text, text) is
  'Pure classifier used by memory SELECT RLS; mirrors the family-memory category and sensitive-term rule across label, value, and free-text context.';

-- Supabase grants EXECUTE to client roles by default. The policy needs this
-- pure predicate for authenticated requests; anon has no need to call it.
revoke all on function public.family_memory_text_is_sensitive(text, text, text, text) from public, anon;
grant execute on function public.family_memory_text_is_sensitive(text, text, text, text) to authenticated, service_role;

drop policy if exists family_facts_sensitive_text_select_guard on public.family_facts;
create policy family_facts_sensitive_text_select_guard
  on public.family_facts as restrictive
  for select to authenticated
  using (
    not public.family_memory_text_is_sensitive(category, label, value, notes)
    or public.can_manage_family(family_id)
  );

drop policy if exists family_playbook_suggestions_sensitive_text_select_guard on public.family_playbook_suggestions;
create policy family_playbook_suggestions_sensitive_text_select_guard
  on public.family_playbook_suggestions as restrictive
  for select to authenticated
  using (
    not public.family_memory_text_is_sensitive(category, label, value, evidence)
    or public.can_manage_family(family_id)
  );

do $$
declare
  v_authenticated oid;
  v_policy_count integer;
begin
  select oid into v_authenticated from pg_catalog.pg_roles where rolname = 'authenticated';
  if v_authenticated is null then
    raise exception 'memory text RLS: authenticated role is missing';
  end if;

  select count(*) into v_policy_count
    from pg_catalog.pg_policy
   where polname in (
     'family_facts_sensitive_text_select_guard',
     'family_playbook_suggestions_sensitive_text_select_guard'
   )
     and not polpermissive
     and polcmd = 'r'
     and polroles @> array[v_authenticated];
  if v_policy_count <> 2 then
    raise exception 'memory text RLS: both restrictive authenticated SELECT guards must exist';
  end if;

  if not pg_catalog.has_function_privilege(
    'authenticated',
    'public.family_memory_text_is_sensitive(text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'memory text RLS: authenticated cannot execute its policy predicate';
  end if;
  if pg_catalog.has_function_privilege(
    'anon',
    'public.family_memory_text_is_sensitive(text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'memory text RLS: anon unexpectedly can execute the policy predicate';
  end if;

  raise notice 'memory text RLS OK: ordinary household reads remain available; sensitive memory rows require a parent/adult manager.';
end
$$;
