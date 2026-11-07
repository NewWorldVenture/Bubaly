-- 0530 — A pending recommendation is a parent's or another adult's decision.
-- Requested on #771 in comment 6422815707, before any SQL: CALHUB-O3 (the
-- database half of CALHUB-02): "The RLS policy on family_ai_recommendations
-- (0022) is FOR ALL is_family_member, so a member can still update or delete a
-- pending recommendation directly over PostgREST."
--
-- A pending recommendation waits on the parents: Needs You, Home and the
-- briefing read status = 'pending'. The app makes every write a parent's or
-- adult's, or the server's: setRecommendationStatus refuses anyone but
-- isManager, the generic record actions list the table in MANAGER_ONLY
-- (lib/family/actions.ts), and the planner files its cards through the run
-- ledger's service client (lib/ai/runs/store.ts ledgerClient). Measured on a
-- replay of main, as a child, one PostgREST statement each, OK 1 every time:
-- dismissing the parents' pending "Book the dentist", deleting it, and planting
-- a high-priority pending card ("Confirm your account"). sameAppHref already
-- keeps a planted cta_href from linking out of the app.
--
-- a_recommendation_is_decided_by_a_parent_or_adult(), SECURITY DEFINER with a
-- pinned search_path, BEFORE INSERT, UPDATE and DELETE: for a signed-in caller,
-- a write needs can_manage_family of the row's family, old and new (42501).
-- INSERT is covered as well as the finding's UPDATE and DELETE: the app never
-- files one as a non-manager. The service role and session-less writers are
-- exempt, and so are two cascades that may run in a signed-in session: the
-- household's deletion, once its family row is gone (Postgres runs the cascades
-- from families in an order it does not fix, so its members may already be gone
-- and its parent no longer its parent), and a member's removal emptying
-- member_id (0022's on delete set null) once their row is gone and nothing else
-- changes. Reads are unchanged. A trigger rather than restrictive
-- policies, as 0464 reasoned, so gated-write-tables-check.sql and the client
-- guard keep their inventory.
--
-- HELD: 0530, requested on #771 in comment 6422815707 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-pending-recommendation-is-a-parents-or-adults-decision-check.sql
-- and .github/workflows/recommendation-decision-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.a_recommendation_is_decided_by_a_parent_or_adult()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end; -- service role / server-side jobs
  end if;
  -- The household's own deletion cascading: its family row is already gone.
  -- Postgres runs the cascades from families in an order it does not fix (by
  -- constraint trigger name), so family_members may already be gone and the
  -- parent who deleted it no longer its parent.
  if tg_op = 'DELETE' and not exists (select 1 from public.families f where f.id = old.family_id) then
    return old;
  end if;
  -- A member's removal emptying member_id, and nothing else.
  if tg_op = 'UPDATE' and old.member_id is not null and new.member_id is null
     and not exists (select 1 from public.family_members m where m.id = old.member_id)
     and (to_jsonb(new) - 'member_id' - 'updated_at') = (to_jsonb(old) - 'member_id' - 'updated_at') then
    return new;
  end if;
  if (tg_op <> 'DELETE' and not public.can_manage_family(new.family_id))
     or (tg_op <> 'INSERT' and not public.can_manage_family(old.family_id)) then
    raise exception 'A recommendation waits on a parent or another adult' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

comment on function public.a_recommendation_is_decided_by_a_parent_or_adult() is
  'Refuses (42501) a signed-in caller''s insert, update or delete of a family_ai_recommendations row unless they are a parent or adult of its family (0530). The service role, the household''s deletion and a member''s removal emptying member_id are exempt.';

revoke all on function public.a_recommendation_is_decided_by_a_parent_or_adult() from public, anon;

do $$
begin
  if to_regclass('public.family_ai_recommendations') is null then
    raise exception '0530 needs public.family_ai_recommendations (0022)';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0530 needs public.can_manage_family(uuid)';
  end if;
  drop trigger if exists trg_family_ai_recommendations_parent_or_adult on public.family_ai_recommendations;
  create trigger trg_family_ai_recommendations_parent_or_adult before insert or update or delete on public.family_ai_recommendations
    for each row execute function public.a_recommendation_is_decided_by_a_parent_or_adult();
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                  where g.tgrelid = 'public.family_ai_recommendations'::regclass
                    and g.tgfoid = 'public.a_recommendation_is_decided_by_a_parent_or_adult()'::regprocedure
                    and g.tgenabled <> 'D'
                    and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28  -- ROW, BEFORE, INSERT/UPDATE/DELETE
                    and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') then
    raise exception '0530: the recommendation guard is not in place';
  end if;
end
$$;
