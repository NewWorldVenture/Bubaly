-- Bubaly :: 0463 - a read receipt, and a reaction, are the reader's own
--                   (DB-RPC-M02)
-- ----------------------------------------------------------------------------
-- 0367 made a family chat message its sender's, and deliberately left three
-- columns open to every member because other members legitimately change
-- them: `reactions`, `read_by` and `is_pinned`. Every writer in the product
-- changes only the CALLER's own entry in the first two:
--
--   mark_conversation_read (0163)   appends auth.uid() to read_by
--   the messages module's fallback  read_by: [...m.read_by, userId]
--   reactTo()                       adds or removes userId under one emoji
--
-- The trigger never said so. Measured on a database replayed through 0462, as
-- a CHILD of the family, against Mom's message that Mom and Dad had read and
-- Dad had 👍'd:
--
--   update family_messages set read_by = array[mom], reactions = '{}' ...
--   -> UPDATE 1: Dad's read receipt and Dad's reaction are gone.
--
-- The same write marks a message read FOR someone who never opened it (so
-- their unread badge never shows it), and adds a reaction in their name. On
-- INSERT, where 0367 checks only the sender, a message could be posted
-- already "read" by everyone.
--
-- The rule, for INSERT and for an UPDATE that names either column: the only
-- id that may enter or leave `read_by`, and the only person who may enter or
-- leave any emoji's list in `reactions`, is the caller. `reactions` must stay
-- an object of emoji -> array of ids when it changes. `is_pinned` stays
-- anyone's in the family, as 0367 decided. The service role (no auth.uid())
-- is unaffected, as in 0367.
--
-- Probe: docs/audit/a-read-receipt-is-the-readers-own-check.sql.

create or replace function public.family_message_receipts_are_the_callers()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  me       uuid := auth.uid();
  old_read uuid[] := '{}';
  old_rx   jsonb := '{}';
  new_rx   jsonb := coalesce(new.reactions, '{}'::jsonb);
begin
  if me is null then
    return new; -- service role / server-side jobs
  end if;
  if tg_op = 'UPDATE' then
    old_read := coalesce(old.read_by, '{}');
    old_rx := coalesce(old.reactions, '{}'::jsonb);
  end if;

  if exists (
       select 1
         from ((select r from unnest(coalesce(new.read_by, '{}'::uuid[])) r
                except select r from unnest(old_read) r)
               union
               (select r from unnest(old_read) r
                except select r from unnest(coalesce(new.read_by, '{}'::uuid[])) r)) changed(id)
        where changed.id is distinct from me) then
    raise exception 'A read receipt is only its reader''s to add or remove'
      using errcode = '42501';
  end if;

  if new_rx is distinct from old_rx then
    if jsonb_typeof(new_rx) <> 'object'
       or exists (select 1 from jsonb_each(new_rx) e
                   where jsonb_typeof(e.value) <> 'array'
                      or exists (select 1 from jsonb_array_elements(e.value) v where jsonb_typeof(v) <> 'string')) then
      raise exception 'Reactions are a map of emoji to lists of people'
        using errcode = '22023';
    end if;
    if exists (
         with before as (
           select e.key as emoji, v.value #>> '{}' as who
             from jsonb_each(case when jsonb_typeof(old_rx) = 'object' then old_rx else '{}'::jsonb end) e
             cross join lateral jsonb_array_elements(case when jsonb_typeof(e.value) = 'array' then e.value else '[]'::jsonb end) v
         ), after as (
           select e.key as emoji, v.value #>> '{}' as who
             from jsonb_each(new_rx) e
             cross join lateral jsonb_array_elements(e.value) v
         )
         select 1
           from ((select * from after except select * from before)
                 union
                 (select * from before except select * from after)) changed
          where changed.who is distinct from me::text) then
      raise exception 'A reaction is only its author''s to add or remove'
        using errcode = '42501';
    end if;
  end if;

  return new;
end
$$;

comment on function public.family_message_receipts_are_the_callers() is
  'Only the caller''s own id may enter or leave family_messages.read_by or any emoji''s list in reactions (0463). The service role is exempt.';

do $$
begin
  if to_regclass('public.family_messages') is null then
    return;
  end if;
  drop trigger if exists trg_family_message_receipts_are_the_callers on public.family_messages;
  create trigger trg_family_message_receipts_are_the_callers
    before insert or update of read_by, reactions on public.family_messages
    for each row execute function public.family_message_receipts_are_the_callers();
end
$$;
