-- Bubaly :: 0327 - stamping one paperwork action must not rewrite the others
--
-- `materializePaperworkActionAction` promises, in its own doc comment, that
-- "tapping twice never double-creates". It kept that promise with a
-- read-modify-write over the whole `actions` array:
--
--   const actions = item.actions;                    -- read
--   ... create the calendar event / reminder ...
--   const next = actions.map((a, i) => i === idx ? { ...a, materialized_id } : a);
--   await supabase.from('paperwork_items').update({ actions: next })  -- write ALL
--
-- Two overlapping calls both read the same array and the second write erases
-- the first one's stamp. The record it created still exists; the item no longer
-- says so; the next tap creates a second one.
--
-- That is the ordinary gesture, not a rare interleaving.
-- `components/modules/paperwork-module.tsx` renders one button per action and
-- disables only the busy one (`disabled={pending && busy}` against a single
-- `busyKey`), so "Add to calendar" followed by "Remind me" on one permission
-- slip issues two overlapping server actions — and starting the second re-enables
-- the first button mid-flight. Measured in
-- tests/a-paperwork-stamp-does-not-erase-its-sibling.test.ts: one stamp lost,
-- and the retap created a second calendar event.
--
-- This function stamps ONE element in the database, so concurrent stamps on
-- different actions cannot erase each other, and it refuses to stamp an element
-- that already carries a `materialized_id` — the check and the write in one
-- statement instead of a read in the application and a write much later.
--
-- SECURITY INVOKER (the plpgsql default, stated here because it is the point):
-- the caller's RLS decides which rows they may touch, exactly as the direct
-- UPDATE it replaces did. It is not a way around paperwork_items_update.
--
-- NOT CLOSED, and named rather than implied: two taps on the SAME action inside
-- the window between creating the record and calling this function. Closing it
-- means claiming the action before the record exists, which trades a rare
-- double-create for a claim that can get stuck when the request dies in between.
-- That is a product decision about which failure a family would rather have.
-- Audit C1-S8-05.

create or replace function public.paperwork_stamp_action(
  p_item_id uuid,
  p_index   int,
  p_as      text,
  p_id      text
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  stamped jsonb;
begin
  if p_index is null or p_index < 0 or p_as is null or p_id is null or p_id = '' then
    return false;
  end if;

  update public.paperwork_items
     set actions = jsonb_set(
           jsonb_set(actions, array[p_index::text, 'materialized_id'], to_jsonb(p_id), true),
           array[p_index::text, 'materialized_as'], to_jsonb(p_as), true)
   where id = p_item_id
     and jsonb_typeof(actions) = 'array'
     and actions -> p_index is not null
     -- Already stamped by someone else: their write stands, and this caller is
     -- told it did not win so it never reports a second record as filed.
     and coalesce(actions -> p_index ->> 'materialized_id', '') = ''
  returning actions into stamped;

  if stamped is null then
    return false;
  end if;

  -- Recomputed from the row as it stands NOW, not from this caller's copy: a
  -- stamp that landed in between must count toward "done" rather than be
  -- overwritten back to "in_progress" — the same mistake one level down.
  update public.paperwork_items
     set status = case
       when not exists (
         select 1 from jsonb_array_elements(actions) e
          where coalesce(e ->> 'materialized_id', '') = ''
       ) then 'done' else 'in_progress' end
   where id = p_item_id
     and status is distinct from 'archived';

  return true;
end
$$;

revoke all on function public.paperwork_stamp_action(uuid, int, text, text) from public;
grant execute on function public.paperwork_stamp_action(uuid, int, text, text) to authenticated;
