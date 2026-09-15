-- Bubaly :: 0302 One live system policy per family, per name
-- ----------------------------------------------------------------------------
-- `trust_policies` has exactly one unique index: the primary key on `id`.
-- Nothing stops a family holding two policies with the same `name`, and
-- `setConciergeAutopilotAction` is a check-then-insert over exactly that name:
--
--   const { data: existing } = await sb.from('trust_policies').select('id')
--     .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME).maybeSingle();
--   if (existing?.id) { ...update... } else { ...insert... }
--
-- The read error is not destructured, and that is what makes this self-
-- worsening rather than merely racy. Measured on a replayed database:
--
--   two rows, name 'Concierge autopilot', effects allow + deny, both priority 10
--     -> accepted, no constraint objects
--   the single-row read of that pair -> 2 rows, which PostgREST rejects
--
-- So once a family has two, `existing` is null with an error nobody reads,
-- `existing?.id` is undefined, and the action takes the INSERT branch — adding
-- a THIRD row. Every later change to the dial adds another. The panel
-- (components/concierge/autopilot-panel.tsx) reads the same row the same way,
-- checks only the other feed's error, and renders dialLevel(undefined): the
-- default. A parent's control over whether Bubaly acts on its own silently
-- stops taking effect and stops telling the truth about its own state.
--
-- Which of the duplicates governs is a separate question this does not answer
-- from observation: lib/trust/engine.ts sorts by `priority` alone and
-- loadTrustInputs issues no ORDER BY, so equal priorities have no tiebreak.
-- Postgres does not promise an order without one. It was NOT observed to flip
-- in the harness here — an index scan served both reads — so the claim made is
-- only that the order is unspecified, not that it changes.
--
-- The repair DISABLES rather than deletes. `loadTrustInputs` filters
-- `enabled = true`, so a disabled row stops reaching the engine immediately,
-- and the row survives for anyone who wants to see what happened — a migration
-- should not destroy a household's rows to make an index fit. The index is
-- partial on `enabled` to match, so the invariant it enforces is exactly the
-- one that matters: at most one LIVE system policy per family per name.
--
-- Scoped to `is_system`, which only setConciergeAutopilotAction sets. Policies
-- a family writes by hand (app/(app)/dashboard/trust/actions.ts) leave it at
-- its `false` default and are not constrained — two hand-written policies may
-- legitimately share a name across different domains.
--
-- Idempotent: after this runs each group has one enabled row, so a replay
-- disables nothing and the index already exists.

do $$
declare
  repaired integer;
begin
  with ranked as (
    select id,
           row_number() over (
             partition by family_id, name
             order by updated_at desc nulls last, created_at desc nulls last, id
           ) as rn
      from public.trust_policies
     where is_system and enabled
  )
  update public.trust_policies p
     set enabled = false
    from ranked r
   where p.id = r.id and r.rn > 1;
  get diagnostics repaired = row_count;

  if repaired > 0 then
    raise warning '0302: disabled % duplicate live system policy row(s); the most recently updated one in each group is the survivor', repaired;
  end if;
end $$;

create unique index if not exists uq_trust_policies_live_system_name
  on public.trust_policies (family_id, name)
  where is_system and enabled;

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'uq_trust_policies_live_system_name'
  ) then
    raise exception '0302: the live-system-policy index was not created';
  end if;
  if exists (
    select family_id, name from public.trust_policies
     where is_system and enabled
     group by family_id, name having count(*) > 1
  ) then
    raise exception '0302: a family still holds two live system policies with one name';
  end if;
end $$;
