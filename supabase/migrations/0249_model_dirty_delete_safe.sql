-- ============================================================
-- Migration 0249: mark_model_dirty() must survive a family being deleted
--
-- 0134 attached `trg_mark_model_dirty` (AFTER INSERT/UPDATE/DELETE) to
-- family_members, pets, vehicles, school_classes, teams, family_routines,
-- family_places, financial_accounts, vacations and documents. When a family
-- row is deleted, Postgres cascades to those tables and each cascaded DELETE
-- fires the trigger with old.family_id — but the families row is already
-- gone, so the trigger's INSERT into family_model_dirty violates
-- family_model_dirty_family_id_fkey and the whole family delete fails:
--
--   insert or update on table "family_model_dirty" violates foreign key
--   constraint "family_model_dirty_family_id_fkey"
--
-- Every account-closure / family-deletion path (and the E2E cleanup) hits
-- this as soon as the family has a single member. A family that is being
-- deleted has nothing to re-project, so the trigger now skips ids that no
-- longer exist and swallows the FK race. Additive + idempotent.
-- ============================================================

create or replace function public.mark_model_dirty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid;
begin
  v_family := coalesce((case when tg_op = 'DELETE' then old.family_id else new.family_id end), null);
  if v_family is null then
    return null;
  end if;
  -- The family is mid-delete (cascade) or already gone: nothing to mark.
  if not exists (select 1 from public.families f where f.id = v_family) then
    return null;
  end if;
  begin
    insert into public.family_model_dirty (family_id, dirty, reason, marked_at)
    values (v_family, true, tg_table_name, now())
    on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now();
  exception when foreign_key_violation then
    -- Deleted between the existence check and the insert; same answer.
    return null;
  end;
  return null; -- AFTER trigger, result ignored
end $$;
