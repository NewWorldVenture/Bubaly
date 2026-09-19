-- Bubaly :: 0318 - a pinned search_path must still reach the extension
--
-- `marketplace_create_circle` has never worked on this database. Calling it:
--
--   NOTICE: marketplace_create_circle -> FAILS:
--           function gen_random_bytes(integer) does not exist (42883)
--
-- The function is `security definer` and pins `set search_path = public`, which
-- is the correct instinct: a definer function that inherits the caller's
-- search_path can be made to resolve `families` or `auth.uid` to something the
-- caller planted. But pgcrypto is not in `public`. Supabase installs its
-- extensions into a schema called `extensions`, so pinning `public` alone pins
-- away the very function the body calls:
--
--   set search_path = public;              select gen_random_bytes(8);  -- 42883
--   set search_path = public, extensions;  select gen_random_bytes(8);  -- \x9f4c...
--
-- This is not a 0314 regression. 0176_marketplace_circles.sql:133 declared the
-- same `set search_path = public` when the function was born, so creating a
-- marketplace circle has failed since the day the feature shipped. 0314 fixed
-- the code's ambiguous-character bug (`translate` running before `upper`) in a
-- generator that never got as far as generating.
--
-- The working precedent is already in the tree: 0238's
-- `sync_blog_image_provenance` pins `SET search_path = public, extensions` and
-- calls `digest()` happily. Adding `extensions` does not loosen the pin — the
-- schema holds extension functions and is not writable by `authenticated`, so
-- it cannot be used to shadow anything in `public`.
--
-- `marketplace_join_circle` and `marketplace_leave_circle` keep their bare
-- `public` pin: they call nothing from `extensions`, and a search_path should
-- name what the body actually needs and no more.
--
-- `invites.token` (0002_tables.sql:71) uses `gen_random_bytes` too, but as a
-- COLUMN DEFAULT. A default's function references are resolved to OIDs when the
-- column is declared, so the search_path in force at insert time is irrelevant
-- and that call site is sound. Function bodies resolve at call time; that is the
-- whole difference, and it is why the grep for "calls gen_random_bytes" finds
-- two sites and only one of them is broken.

create or replace function public.marketplace_create_circle(
  p_family uuid,
  p_name text,
  p_emoji text default '🤝'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_circle uuid;
  v_code   text;
  v_name   text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'circle needs a name';
  end if;

  select name into v_name from public.families where id = p_family;
  -- 8-char human-friendly code, retried on the rare collision.
  --
  -- The from-set carries BOTH cases of the ambiguous letters, because
  -- `translate` runs before `upper` and a lowercase `o` or `i` would otherwise
  -- be uppercased back into the character this line exists to remove (0314).
  loop
    v_code := upper(substr(translate(encode(gen_random_bytes(8), 'base64'),
                                     '0O1Iloi+/=', 'ABCDEJKFGH'), 1, 8));
    exit when not exists (select 1 from public.marketplace_circles c where c.join_code = v_code);
  end loop;

  insert into public.marketplace_circles (name, emoji, join_code, created_by_family, created_by)
  values (trim(p_name), coalesce(nullif(trim(p_emoji), ''), '🤝'), v_code, p_family, auth.uid())
  returning id into v_circle;

  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
  values (v_circle, p_family, coalesce(v_name, 'A family'), 'owner');

  return v_circle;
end $$;

comment on function public.marketplace_create_circle(uuid, text, text) is
  'Creates a sharing circle and its owner membership. search_path names `extensions` as well as `public` because pgcrypto lives there and the body calls gen_random_bytes — pinning `public` alone raised 42883 on every call from 0176 until 0318. The join code excludes 0, 1, O and I in both cases (0314).';
