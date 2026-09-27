-- A circle can be created on Supabase, where pgcrypto lives in `extensions`.
--
-- `marketplace_create_circle` makes its join code with `gen_random_bytes`, a
-- pgcrypto function, and pins `set search_path = public` (0176, 0314). On
-- Supabase, hosted and local alike, pgcrypto is installed in the `extensions`
-- schema; 0001's `create extension if not exists "pgcrypto"` finds it there
-- and does nothing. So inside the function `gen_random_bytes` does not
-- resolve, and every "Create circle" on /marketplace/community failed with
-- `function gen_random_bytes(integer) does not exist` (42883), shown to the
-- family as "Could not create the circle." CI never saw it: its replay runs on
-- plain Postgres, where the same `create extension` puts pgcrypto in `public`.
--
-- The body is 0314's, unchanged. Only the search path gains `extensions`,
-- after `public`, so nothing the function names resolves differently; on a
-- database with no `extensions` schema Postgres skips the entry.
-- docs/audit/circle-create-where-pgcrypto-lives-check.sql moves pgcrypto into
-- `extensions` inside a rolled-back transaction and creates a circle.

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
  -- be uppercased back into the character this line exists to remove.
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
  'Creates a sharing circle and its owner membership. The join code excludes 0, 1, O and I in both cases — translate runs before upper, so the from-set must name the lowercase letters too (0314). search_path includes extensions, where Supabase keeps pgcrypto (0444).';
