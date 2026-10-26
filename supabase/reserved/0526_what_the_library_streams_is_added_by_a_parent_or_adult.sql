-- 0526 — What the family library streams is added by a parent or another adult.
-- Requested on #771 in comment 6420549131, before any SQL: KIDS-O02 ("The
-- library_feeds and library_items INSERT/UPDATE policies have no role
-- predicate"), and lib/library/curator.ts's own note: "The durable rule is a
-- database trigger on library_items (media_url, feed_id, created_by) and
-- library_feeds (feed_url, created_by), an owner migration."
--
-- A subscription's episodes, and a book's audio address, land in every
-- member's library, a young child's included, and stream through Bubaly's own
-- media route past whatever filter a parent set for the publisher's host. The
-- actions let only a parent or adult subscribe or attach an audio address
-- (app/(app)/dashboard/library/actions.ts), and the places that fetch ask who
-- added the row (lib/library/curator.ts). But 0284's policies are `for all
-- using is_family_member(family_id)`, and created_by is whatever the writer
-- says. Measured on a replay of main, one PostgREST statement each, OK 1 every
-- time: a child inserted a feed under the parent's name, retargeted the
-- parent's feed, inserted a book with an audio address, filed an episode with
-- one under the parent's feed, and rewrote the parent's audiobook's media_url;
-- a teen rewrote it too. (A guest is refused already, by 0481's guard.)
--
-- A BEFORE INSERT OR UPDATE trigger on each table, for a signed-in caller:
--
--   library_feeds   only a parent or adult (can_manage_family) adds a feed, or
--                   changes its feed_url or its family. Its descriptive columns
--                   (title, author, description, image_url, last_fetched_at,
--                   last_error) stay anyone's.
--   library_items   only a parent or adult adds a row with a media_url or a
--                   feed_id, or changes either, or moves a row to another
--                   family. Anyone still adds a title or a page link.
--   created_by      on both: on insert, the writer or null; afterwards it
--                   changes only to the caller, a parent or adult, or to null
--                   once that account is gone (0284's on delete set null).
--
-- Moving a row between families takes a parent or adult of both. Deletes are
-- unchanged. SECURITY DEFINER with a pinned search_path, so the account check
-- can read auth.users. The service role and session-less writers are exempt (no
-- auth.uid()), as in 0464: the nightly ingest, and Refresh, whose ingest the
-- server writes for whoever pressed it once the action has read the feed in the
-- presser's own family and checked who added it.
--
-- HELD: 0526, requested on #771 in comment 6420549131 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/what-the-library-streams-is-added-by-a-parent-or-adult-check.sql
-- and .github/workflows/library-curation-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

-- One function per table: a body that names the other table's column would not
-- resolve against this one (docs/audit/plpgsql-bodies-resolve-check.sql). The
-- triggers are named to fire after 0481's trg_<table>_not_a_guests (same-event
-- triggers fire in name order), so a guest is still answered by 0464's guard.
create or replace function public.a_library_feed_is_added_by_a_parent_or_adult()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    return new; -- service role / server-side jobs
  end if;
  if tg_op = 'INSERT' then
    if not public.can_manage_family(new.family_id) then
      raise exception 'Only a parent or another adult adds or changes a subscription in the family library' using errcode = '42501';
    end if;
  elsif (new.family_id, new.feed_url) is distinct from (old.family_id, old.feed_url)
        and not (public.can_manage_family(new.family_id) and public.can_manage_family(old.family_id)) then
    raise exception 'Only a parent or another adult adds or changes a subscription in the family library' using errcode = '42501';
  end if;
  if (tg_op = 'INSERT' and new.created_by is not null and new.created_by <> me)
     or (tg_op = 'UPDATE' and new.created_by is distinct from old.created_by
         and not (new.created_by is not distinct from me and public.can_manage_family(new.family_id))
         and not (new.created_by is null and not exists (select 1 from auth.users u where u.id = old.created_by))) then
    raise exception 'A row in the family library names the adult who added it' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function public.a_library_items_audio_is_added_by_a_parent_or_adult()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    return new; -- service role / server-side jobs
  end if;
  if tg_op = 'INSERT' then
    if (new.media_url is not null or new.feed_id is not null)
       and not public.can_manage_family(new.family_id) then
      raise exception 'Only a parent or another adult adds or changes audio in the family library' using errcode = '42501';
    end if;
  elsif (new.family_id, new.feed_id, new.media_url) is distinct from (old.family_id, old.feed_id, old.media_url)
        and not (public.can_manage_family(new.family_id) and public.can_manage_family(old.family_id)) then
    raise exception 'Only a parent or another adult adds or changes audio in the family library' using errcode = '42501';
  end if;
  if (tg_op = 'INSERT' and new.created_by is not null and new.created_by <> me)
     or (tg_op = 'UPDATE' and new.created_by is distinct from old.created_by
         and not (new.created_by is not distinct from me and public.can_manage_family(new.family_id))
         and not (new.created_by is null and not exists (select 1 from auth.users u where u.id = old.created_by))) then
    raise exception 'A row in the family library names the adult who added it' using errcode = '42501';
  end if;
  return new;
end
$$;

comment on function public.a_library_feed_is_added_by_a_parent_or_adult() is
  'Refuses (42501) a signed-in caller''s library_feeds insert, or change of feed_url or family, unless they are a parent or adult of the family (0526); created_by is the writer, and later only the caller (a parent or adult) or null once its account is gone. The service role is exempt.';
comment on function public.a_library_items_audio_is_added_by_a_parent_or_adult() is
  'Refuses (42501) a signed-in caller''s library_items insert or change carrying a media_url or feed_id, or a move to another family, unless they are a parent or adult of the family (0526); created_by as on library_feeds. A title or page link stays anyone''s. The service role is exempt.';

revoke all on function public.a_library_feed_is_added_by_a_parent_or_adult() from public, anon;
revoke all on function public.a_library_items_audio_is_added_by_a_parent_or_adult() from public, anon;

do $$
begin
  if to_regclass('public.library_feeds') is null or to_regclass('public.library_items') is null then
    raise exception '0526 needs public.library_feeds and public.library_items (0284)';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0526 needs public.can_manage_family(uuid)';
  end if;
  drop trigger if exists trg_library_feeds_parent_or_adult on public.library_feeds;
  create trigger trg_library_feeds_parent_or_adult before insert or update on public.library_feeds
    for each row execute function public.a_library_feed_is_added_by_a_parent_or_adult();
  drop trigger if exists trg_library_items_parent_or_adult on public.library_items;
  create trigger trg_library_items_parent_or_adult before insert or update on public.library_items
    for each row execute function public.a_library_items_audio_is_added_by_a_parent_or_adult();
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger g
   where ((g.tgrelid = 'public.library_feeds'::regclass
           and g.tgfoid = 'public.a_library_feed_is_added_by_a_parent_or_adult()'::regprocedure)
          or (g.tgrelid = 'public.library_items'::regclass
              and g.tgfoid = 'public.a_library_items_audio_is_added_by_a_parent_or_adult()'::regprocedure))
     and g.tgenabled <> 'D'
     and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2      -- FOR EACH ROW, BEFORE
     and (g.tgtype & 4) = 4 and (g.tgtype & 16) = 16    -- INSERT, UPDATE
     and (g.tgtype & 8) = 0;                            -- not DELETE
  if n <> 2 then
    raise exception '0526: % of 2 library tables carry the parent-or-adult guard', n;
  end if;
  if (select count(*) from pg_proc p
       where p.oid in ('public.a_library_feed_is_added_by_a_parent_or_adult()'::regprocedure,
                       'public.a_library_items_audio_is_added_by_a_parent_or_adult()'::regprocedure)
         and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') <> 2 then
    raise exception '0526: both guards must be SECURITY DEFINER with a pinned search_path';
  end if;
  -- 0481's guest guards stay where they are.
  if (select count(*) from pg_trigger g
       where g.tgname in ('trg_library_feeds_not_a_guests', 'trg_library_items_not_a_guests')
         and g.tgenabled <> 'D') <> 2 then
    raise exception '0526: 0481''s guest guards on the library tables are not both in place';
  end if;
end
$$;
