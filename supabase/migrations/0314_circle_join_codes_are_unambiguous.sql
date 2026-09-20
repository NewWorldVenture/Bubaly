-- Bubaly :: 0314 - a join code the family reads aloud must be typeable
--
-- `marketplace_create_circle` builds the 8-character code a family shares with
-- the neighbours they lend things to, and says what it is for:
--
--   -- 8-char human-friendly code (no 0/O/1/I), retried on the rare collision.
--   v_code := upper(substr(translate(
--     encode(gen_random_bytes(8), 'base64'), '0O1Il+/=', 'ABCDEFGH'), 1, 8));
--
-- `translate` runs BEFORE `upper`, and the from-set names only the UPPERCASE
-- `O` and `I`. base64 emits lowercase letters too. So a lowercase `o` or `i`
-- passes through untouched and `upper()` turns it back into exactly the
-- character the line set out to remove.
--
-- Measured on 20,000 generated codes:
--
--   codes containing 0 or 1 : 0        (the digits really are excluded)
--   codes containing O or I : 4,568    -- 22.8%
--
--   OWSBVEFD   YYEQDIBA   THOLKTVA   TNEIEAWB
--
-- Nearly one code in four carries the ambiguity, and the failure is a
-- dead end: `0` and `1` can never appear in a stored code, so a parent who
-- reads `OWSBVEFD` off a screen and types a zero gets "no circle with that
-- code" every time, with nothing to tell them they are one character away.
--
-- ── both halves ─────────────────────────────────────────────────────────────
--
-- Fixing the generator only helps circles created from now on. The 22.8% that
-- already exist keep their codes — rotating them would break the codes families
-- have already written down. So the LOOKUP forgives the ambiguity instead: a
-- typed `0` is read as `O` and a typed `1` as `I`, which is unconditionally
-- safe precisely because a stored code can never contain a digit `0` or `1`.
-- The probe asserts that premise rather than assuming it.
--
-- After the fix the alphabet is 23456789ABCDEFGHJKLMNPQRSTUVWXYZ — 32
-- characters, measured over 50,000 codes, none of them 0, 1, O or I.

create or replace function public.marketplace_create_circle(
  p_family uuid,
  p_name text,
  p_emoji text default '🤝'
)
returns uuid
language plpgsql
security definer
set search_path = public
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
  'Creates a sharing circle and its owner membership. The join code excludes 0, 1, O and I in both cases — translate runs before upper, so the from-set must name the lowercase letters too (0314).';

create or replace function public.marketplace_join_circle(p_family uuid, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle uuid;
  v_name   text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;

  -- Read a typed `0` as `O` and a typed `1` as `I`. Safe unconditionally: the
  -- generator maps both digits away, so no stored code contains either, and a
  -- code carrying an `O` or `I` from before 0314 stays joinable.
  select id into v_circle from public.marketplace_circles
  where join_code = translate(upper(trim(p_code)), '01', 'OI');
  if v_circle is null then
    raise exception 'no circle with that code';
  end if;

  select name into v_name from public.families where id = p_family;

  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
  values (v_circle, p_family, coalesce(v_name, 'A family'), 'member')
  on conflict (circle_id, family_id) do nothing;

  return v_circle;
end $$;

comment on function public.marketplace_join_circle(uuid, text) is
  'Joins a sharing circle by its code. A typed 0 reads as O and a typed 1 as I, so codes generated before 0314 — 22.8% of which carry an ambiguous character — stay joinable (0314).';
