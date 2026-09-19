-- Bubaly :: 0323 - a family timezone is a zone that exists
--
-- `families.timezone` is the zone every wall-clock answer a family gets is
-- computed from: which local day a routine belongs to, what "today" means, the
-- day bounds the medication reminder uses. `components/modules/family-module.tsx`
-- says so itself, above the field:
--
--   // This field is FREE TEXT, and what it writes is the zone every wall-clock
--   // answer this family gets is computed from. `Intl` throws on an unknown
--   // zone and every call site catches and degrades to UTC by design — so
--   // "CST", "Central" or a typo like "Amercia/Chicago" saved silently and left
--   // the family on Greenwich time [...] The form said "Family profile updated"
--   // either way.
--
-- That is the failure exactly, and both application paths now refuse a bad
-- zone: `createFamilySchema.timezone` validates on create and the module calls
-- `isValidTimezone` on edit. `families` itself carried no constraint of any
-- kind, and `families_update` is reachable by any manager's JWT, so the rule
-- lived entirely in the two places that happen to ask.
--
-- ── the guard must accept exactly what Intl accepts ────────────────────────
--
-- A guard checking `pg_timezone_names` alone would be STRICTER than the
-- application and would reject writes the form permits, which closes the
-- product rather than the hole. Postgres keeps IANA zone names and the legacy
-- abbreviations in two different catalogues, and `Intl` accepts both:
--
--   zone              names  abbrevs  union   Intl
--   CST               f      t        yes     accepted
--   PST               f      t        yes     accepted
--   EST               t      t        yes     accepted
--   US/Central        t      f        yes     accepted
--   America/Chicago   t      f        yes     accepted
--   Etc/GMT+5         t      f        yes     accepted
--   UTC / GMT         t      t        yes     accepted
--   Amercia/Chicago   f      f        NO      REJECTED
--
-- The union agrees with `Intl` on every case measured, including the ones that
-- disagree individually. So the union is the rule.
--
-- `CST` being accepted is not an oversight. It is a fixed offset with no DST,
-- so a family in Chicago choosing it will be an hour out for half the year —
-- but `Intl` accepts it, the form accepts it, and a database that refused it
-- would reject a value the product offers. That is a product question about
-- which zones to OFFER, not a reason for the table to disagree with the app.
--
-- ── a trigger, not a CHECK ─────────────────────────────────────────────────
--
-- A CHECK constraint may only call IMMUTABLE functions, and reading
-- `pg_timezone_names` is not immutable — the zone database changes with the
-- server's tzdata. Declaring a function IMMUTABLE when it is not is the kind of
-- lie that survives until a `pg_dump`/restore revalidates every CHECK against a
-- differently-versioned catalogue. A trigger has no such requirement and is
-- what the repository already uses for rules it cannot express as a constraint
-- (0304, 0322).
--
-- Fires only when the value actually changes, so an ordinary family update
-- costs nothing.

create or replace function public.family_timezone_exists()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- NULL is the column's business, not this trigger's: `timezone` is NOT NULL
  -- with a default of 'UTC', so the column already refuses it and a trigger
  -- that also raised would only change which error the caller sees.
  if new.timezone is null then
    return new;
  end if;

  -- Blank is NOT waved through. `Intl.DateTimeFormat` raises a RangeError on
  -- '' exactly as it does on a typo, so an empty zone reaches the same silent
  -- UTC this trigger exists to prevent. (Measured: no family currently stores
  -- one, and the form writes `timezone.trim() || 'UTC'`, so nothing legitimate
  -- sends it.)
  if btrim(new.timezone) <> '' and (
       exists (select 1 from pg_timezone_names   z where z.name   = new.timezone)
    or exists (select 1 from pg_timezone_abbrevs a where a.abbrev = new.timezone)
  ) then
    return new;
  end if;

  raise exception
    '% is not a time zone this server knows; a family saved with it would silently be on UTC', coalesce(nullif(btrim(new.timezone), ''), '(blank)')
    using errcode = '22023';
end $$;

comment on function public.family_timezone_exists() is
  'Refuses a families.timezone that neither pg_timezone_names nor pg_timezone_abbrevs knows. The union is used because Intl accepts both IANA names and legacy abbreviations, and a guard narrower than the application would reject values the form offers (0323).';

do $$
declare
  unknown_zones int;
begin
  if to_regclass('public.families') is null then
    return;
  end if;

  -- Report rather than block. A trigger governs new writes only, so unlike a
  -- constraint it installs regardless of what is already stored — and deciding
  -- what a family's real zone was is not a migration's call.
  select count(*) into unknown_zones
    from public.families f
   where f.timezone is not null and btrim(f.timezone) <> ''
     and not exists (select 1 from pg_timezone_names  z where z.name   = f.timezone)
     and not exists (select 1 from pg_timezone_abbrevs a where a.abbrev = f.timezone);
  if unknown_zones > 0 then
    raise notice
      '0323: % family/families are stored with a zone this server does not know and are therefore being computed on UTC today. The trigger stops new ones; these need a decision.',
      unknown_zones;
  end if;

  drop trigger if exists family_timezone_exists on public.families;
  create trigger family_timezone_exists
    before insert or update of timezone on public.families
    for each row execute function public.family_timezone_exists();
end
$$;
