-- Bubaly :: 0466 - a member's language is kept on their profile
--                   (I18N-001, the storage half; owner decision of 2026-09-29)
-- ----------------------------------------------------------------------------
-- A family's language choice lived in one place: the `bubaly-locale` cookie
-- (LOCALE_COOKIE, lib/i18n/locales.ts). A page can read a cookie; nothing that
-- Bubaly SENDS can. The weekly digest, the notification digest, the chore
-- reminder, every row the notification engine writes (and so every push, which
-- carries the row's text), the money-approval reminders and the morning brief
-- are composed by crons with no request — so every one of them was English with
-- American dates and amounts for everyone, a German parent included, and the
-- code said so in five places ("stored in English for every manager until a
-- per-recipient locale exists"). Measured before this migration:
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and column_name ilike '%locale%';
--   -> only the AEO marketing-translation tables.
--
-- The owner decided: STORE each member's language and use it for everything
-- Bubaly sends them. THIS migration is the storage half: the column, who may
-- write it, and the sign-in step that keeps a person's devices in step. The
-- senders reading it (digests, reminders, notification rows, pushes, emails)
-- are a separate change; until it lands the column is recorded and restored
-- onto a new device, and every sender still writes en-US, as before.
--
-- WHERE: public.profiles, one row per auth user — not family_members. What
-- is being stored is the language a PERSON reads, and a person who belongs to
-- two households reads one language in both; a per-membership column would let
-- the same inbox receive German from one family and English from the other, and
-- the switcher (which has no family in scope on a public page) would have to
-- pick which row to write. A member without a login (a managed child profile)
-- has no inbox, so there is nobody to address and nothing to store.
--
-- WHAT: `locale`, nullable. NULL is "never chosen" and the senders fall back to
-- en-US (DEFAULT_LOCALE), which is exactly what everyone received before this
-- migration — so the column changes nothing until a person picks a language.
-- The CHECK names the locales the product ships (LOCALES in
-- lib/i18n/locales.ts); tests/a-members-language-is-kept-on-their-profile.test.ts
-- holds the two lists equal, so adding a locale in code without here
-- (or here without code) fails in CI rather than at a user's write.
--
-- WHO MAY WRITE IT: the person themselves. `profiles_update_self` (0004) is
-- USING (id = auth.uid()) with no WITH CHECK, so the USING also checks the new
-- row: a member can set only their own locale, never another member's. The
-- RESTRICTIVE policy below says so a second time on the row this column lives
-- on, so a permissive UPDATE policy added to profiles later cannot, on its own,
-- let one member rewrite another's language (and with it the language of every
-- email that member is sent). Reads are unchanged: profiles_select_self (0426)
-- already lets co-members read a profile, and a language is not a secret.
-- The senders read it with the service role.
--
-- WRITTEN BY: lib/i18n/actions.ts setLocale (the language switcher, which still
-- sets the cookie for the UI), and lib/i18n/sync.ts at sign-in and onboarding
-- completion (the language this device was using). At sign-in on a device with
-- no language cookie, sync.ts copies the stored language ONTO the device.
--
-- Probe: docs/audit/a-members-language-check.sql.

alter table public.profiles add column if not exists locale text;

alter table public.profiles drop constraint if exists profiles_locale_supported;
alter table public.profiles add constraint profiles_locale_supported check (
  locale is null or locale in (
    'en-US', 'en-GB',
    'de-DE',
    'es-ES', 'es-MX', 'es-US',
    'fr-FR', 'fr-CA',
    'it-IT',
    'nl-NL',
    'pt-PT'
  )
);

comment on column public.profiles.locale is
  'The language this person reads, as a shipped BCP-47 code (lib/i18n/locales.ts). NULL = never chosen; senders fall back to en-US. Written by the language switcher and at sign-in / onboarding; restored onto a new device at sign-in (0466, I18N-001).';

drop policy if exists profiles_update_own_row_only on public.profiles;
create policy profiles_update_own_row_only on public.profiles
  as restrictive
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Post-conditions: raise rather than leave a half-applied state.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'locale'
  ) then
    raise exception '0466: public.profiles.locale was not created';
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.profiles'::regclass
       and polname = 'profiles_update_self' and polcmd = 'w'
  ) then
    raise exception '0466: profiles_update_self is missing; a member could not set their own language';
  end if;
end
$$;
