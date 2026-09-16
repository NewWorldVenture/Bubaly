-- Bubaly :: 0318 - a policy should say what it checks
-- ----------------------------------------------------------------------------
-- Fifteen policies across eleven tables decide family membership with an inline
-- subquery instead of `is_family_member(family_id)`:
--
--     family_id in (select family_id from family_members where user_id = auth.uid())
--
-- `is_family_member` is `... where family_id = p_family_id and user_id =
-- auth.uid() and is_active`. The inline form has no `is_active`, and removal in
-- this product is exactly `update({ is_active: false })` — three call sites:
-- components/modules/family-module.tsx:483, components/modules/settings-module.tsx:181
-- and app/(app)/admin/actions.ts:200. Read as written, a removed member keeps
-- read AND write on the family's messages, conversations, photos, albums,
-- contacts, recipes, reminders, to-do lists and family tree.
--
-- THAT IS NOT WHAT HAPPENS, and the reason is the point of this migration.
--
-- Measured on a full replay as a removed member (is_active = false), before any
-- change: family_messages 0 rows, family_conversations 0, family_contacts 0,
-- todo_lists 0, and the insert into family_messages refused outright. The
-- inline subquery reads `public.family_members`, and a policy expression is
-- evaluated as the CALLING user — so that read is itself subject to
-- `fm_select`, which IS `is_family_member(family_id)`. A removed member cannot
-- see their own membership row, the subquery returns nothing, and the predicate
-- is false.
--
-- So eleven tables are held closed by a policy on a twelfth. That is the same
-- mechanism main's 0303 had to fix on the document vault, pointed the other
-- way: there, a policy's nested read being filtered by the caller's own RLS
-- opened the boundary; here it happens to close it. Correct today, for a reason
-- none of these fifteen policies states, and not a property anyone changing
-- `fm_select` would think to preserve.
--
-- The failure is concrete rather than hypothetical. `audit/claude-4.md:1596`
-- proposes — correctly — that a removed member should be shown "you are no
-- longer part of <family>" instead of being handed a fresh empty family, and
-- the read that interstitial needs is *their inactive membership row*. Written
-- with the service client, as that note suggests, nothing moves. Written with
-- the session client, it needs `fm_select` widened to admit an inactive
-- membership — and the moment that lands, all eleven tables open to every
-- removed member, silently, in a commit about an onboarding screen.
--
-- This migration changes no behaviour. It makes each policy check the thing it
-- depends on, so that the eleven tables stop being an invisible constraint on
-- the twelfth. docs/audit/removed-member-read-boundary-check.sql proves both
-- halves: the boundary holds, AND it still holds with `fm_select` deliberately
-- widened — the assertion that fails without this migration.

-- ── The ten family-scoped tables ─────────────────────────────────────────────
-- Same shape, same column, one loop. `for all` policies get BOTH halves stated:
-- Postgres reuses a missing `with check` from `using`, which is the reuse 0311
-- was written about, and a policy this long-lived should not rely on a reader
-- knowing that rule.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('family_albums',       'family members can manage albums'),
      ('family_contacts',     'family members can manage contacts'),
      ('family_conversations','family members can manage conversations'),
      ('family_messages',     'family members can manage messages'),
      ('family_photos',       'family members can manage photos'),
      ('family_recipes',      'family members can manage recipes'),
      ('family_reminders',    'family members can manage reminders'),
      ('todo_items',          'family member access'),
      ('todo_lists',          'family member access')
    ) as t(tbl, pol)
  loop
    execute format('drop policy if exists %I on public.%I', spec.pol, spec.tbl);
    execute format(
      'create policy %I on public.%I for all to public '
      'using (public.is_family_member(family_id)) '
      'with check (public.is_family_member(family_id))',
      spec.pol, spec.tbl);
  end loop;
end $$;

-- ── family_tree_nodes: four commands, not one ────────────────────────────────
-- Kept as four so the rewrite is a rewrite and not a consolidation.
drop policy if exists family_tree_nodes_select on public.family_tree_nodes;
create policy family_tree_nodes_select on public.family_tree_nodes
  for select to public using (public.is_family_member(family_id));

drop policy if exists family_tree_nodes_insert on public.family_tree_nodes;
create policy family_tree_nodes_insert on public.family_tree_nodes
  for insert to public with check (public.is_family_member(family_id));

drop policy if exists family_tree_nodes_update on public.family_tree_nodes;
create policy family_tree_nodes_update on public.family_tree_nodes
  for update to public
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

drop policy if exists family_tree_nodes_delete on public.family_tree_nodes;
create policy family_tree_nodes_delete on public.family_tree_nodes
  for delete to public using (public.is_family_member(family_id));

-- ── network_aggregates: the same subquery, one level in ──────────────────────
-- The consent row is the household's; whether the caller still belongs to that
-- household is the same question, asked the same way.
drop policy if exists network_aggregates_select on public.network_aggregates;
create policy network_aggregates_select on public.network_aggregates
  for select to public
  using (
    exists (
      select 1 from public.network_consent nc
      where public.is_family_member(nc.family_id)
        and nc.enabled = true
        and coalesce((nc.scopes ->> network_aggregates.scope)::boolean, false) = true
    )
  );

-- ── profiles: no family_id, so the check is written out ──────────────────────
-- Two joins, and NEITHER checked `is_active`: a removed member could read their
-- old household's profiles, and the household could read a removed member's.
-- `is_family_member` does not fit — `profiles` is keyed by auth user, not by
-- family — so the condition is stated in full instead of being borrowed.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to public
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.family_members me
      join public.family_members them on them.family_id = me.family_id
      where me.user_id = auth.uid() and me.is_active
        and them.user_id = profiles.id and them.is_active
    )
  );

-- ── Sweep by shape ───────────────────────────────────────────────────────────
-- The list above was found by shape rather than by memory, and is re-derived
-- the same way so a table that acquires this predicate tomorrow is caught here
-- rather than in the next audit. `profiles_select_self` is the one policy that
-- legitimately names `family_members` twice with its own `is_active` terms, so
-- the test is for the inline membership subquery, not for the table name.
do $$
declare
  stray text;
begin
  select string_agg(format('%s.%s', c.relname, p.polname), ', ' order by c.relname, p.polname)
    into stray
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
  where position(
          'FROM family_members' in
          coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        ) > 0
    and position(
          'is_active' in
          coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        ) = 0;

  if stray is not null then
    raise exception
      'policies still decide membership by an inline family_members read with no is_active, so they depend on fm_select rather than on themselves: %',
      stray;
  end if;

  raise notice '0318 OK: every membership check states its own is_active';
end $$;
