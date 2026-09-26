-- Bubaly :: 0326 - a Guardian number belongs to one family
-- ----------------------------------------------------------------------------
-- Renumbered from 0310. main landed seven migrations at once — 0304 economy
-- invest decision guard, 0305 chore award amounts, 0306 money instructions,
-- 0307 chore prices, 0308 reward catalogue, 0309 prescriptions, 0310 UI-only
-- manager gates — colliding with this branch's whole 0304-0310 block. The NINTH
-- collision event between the two sessions and by far the largest; every merge
-- since 0300 has brought one. Only the numbers changed: this branch's seven
-- moved together to 0320-0326, keeping their order relative to each other.
--
-- Main's seven are RESTRICTIVE guards (`as restrictive`, 0254's mechanism), so
-- they AND with everything here and nothing in this block can loosen them by
-- running later. The two sets are defence in depth over the same tables rather
-- than one overwriting the other, and the probes are run against the combined
-- chain to say so rather than to assume it.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- `guardian_member_profiles.guardian_phone` is the ONLY key the inbound Twilio
-- webhooks have. All three of them resolve the family from it, across every
-- family, under the service role:
--
--   .eq('guardian_phone', to).eq('is_active', true).maybeSingle()
--
-- The write side guards the other way round, and narrower:
--
--   .eq('family_id', familyId).eq('guardian_phone', phone)     <- ONE family
--
-- So the two sides genuinely disagree about scope, and the writer cannot be
-- taught otherwise: `assignGuardianPhoneAction` uses `createServer()`, which is
-- RLS-bound and could not see another family's row even with the `.eq()`
-- removed. Only a constraint sees both families at once.
--
-- The number is free text. `components/guardian/guardian-number-form.tsx` is a
-- plain controlled input, and the action only normalises to E.164 — so a parent
-- can type any number at all, including one another household already uses, by
-- mistake (their own mobile) or deliberately.
--
-- WHAT HAPPENS WHEN TWO ROWS MATCH is the part that makes this a safety bug
-- rather than a data-quality one. `maybeSingle()` answers `data: null` plus a
-- PGRST116 error on more than one row (postgrest-js PostgrestBuilder: `if
-- (data.length > 1) { error = { code: 'PGRST116' … }; data = null; status =
-- 406 }`). All three routes destructure `{ data: memberProfile }` and DROP the
-- error, so `!memberProfile` reads as "we do not know this number": the SMS and
-- WhatsApp routes mark the event processed and answer 200, and the voice route
-- sends the caller to voicemail.
--
-- Family B typing a number family A already uses therefore takes family A's
-- Guardian offline — scam screening, elder-call routing, the lot — with no
-- error on either side, no log, and Twilio told 200, so nothing is ever
-- retried. Guardian is a safety feature and the failure mode is "the call just
-- never arrives".
--
-- ATTEMPTED, NOT FORCED, in 0285's idiom: if a production database already
-- holds duplicates, this REPORTS them and leaves the data alone rather than
-- choosing which household loses its number. That is a decision for a person.
-- A skip degrades the invariant, not the feature.
--
-- The `where guardian_phone is not null` predicate matters: a profile with no
-- number yet is the normal state for a member Guardian is not watching, and
-- many such rows must coexist.
do $$
declare
  dupes bigint;
begin
  if to_regclass('public.guardian_member_profiles') is null then
    return;
  end if;

  select count(*) into dupes from (
    select guardian_phone from public.guardian_member_profiles
    where guardian_phone is not null
    group by guardian_phone having count(*) > 1
  ) d;

  if dupes > 0 then
    raise warning
      '0326: skipped uq_guardian_profiles_phone — % Guardian number(s) are held by more than one profile. '
      'Every inbound call, SMS and WhatsApp to each of them is being dropped and marked handled RIGHT NOW. '
      'Decide which household keeps each number, clear the others, and then run: '
      'create unique index concurrently uq_guardian_profiles_phone on '
      'public.guardian_member_profiles (guardian_phone) where guardian_phone is not null;',
      dupes;
  else
    create unique index if not exists uq_guardian_profiles_phone
      on public.guardian_member_profiles (guardian_phone)
      where guardian_phone is not null;
    raise notice '0326 OK: a Guardian number now belongs to one family';
  end if;
end $$;
