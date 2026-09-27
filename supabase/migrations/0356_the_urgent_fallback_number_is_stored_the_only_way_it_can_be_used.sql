-- Bubaly :: 0356 The urgent fallback number is stored the only way it can be used
-- ----------------------------------------------------------------------------
-- `public.family_contact_channels.forward_to_phone` is the number the family
-- says to call or text when something at their Contact Center line is urgent.
-- 0214 created the column with the comment "optional human fallback (E.164)"
-- and no constraint behind it, and the write path stored whatever was typed:
--
--   app/(app)/dashboard/contact-center/actions.ts  ->  patch.forward_to_phone = input.forwardTo
--
-- Every consumer requires E.164 and none of them can say so:
--
--   * lib/guardian/twilio.ts `sendSmsWithReceipt` tests /^\+[1-9]\d{7,14}$/ and
--     refuses anything else as `invalid_message`, so the urgent text was
--     rejected before it left the server — and the receipt's error string
--     ("Check the fallback number") is rendered on no screen in the app.
--   * lib/guardian/twilio.ts `twimlDial` interpolates the value into a `<Dial>`
--     element, so a stored '&' or '<' made the TwiML unparseable and the caller
--     heard an application error instead of the family.
--
-- The field's own placeholder was "+1 555 123 4567" — with spaces — so typing
-- exactly what the UI taught produced a fallback number that never once worked.
--
-- The server action now normalizes through `normalizeFallbackPhone`
-- (lib/contact-center/phone.ts), and this migration makes the database enforce
-- the contract its own comment already claimed. There is no client INSERT or
-- UPDATE policy on this table (0214 grants SELECT only) and every write goes
-- through the service role, so this is defense in depth for the next write path
-- rather than a boundary a client can currently route around.
--
-- Existing values are normalized FIRST, the same way phone.ts does it, because a
-- check constraint is enforced on every later UPDATE of a row: a family holding
-- a legacy "(555) 123-4567" would otherwise be unable to save their concierge
-- greeting. What cannot be read as an international number becomes null — it
-- was already guaranteed to be refused by the provider on every send — and the
-- value it replaced is KEPT, in `forward_to_phone_legacy`, so this step destroys
-- nothing a parent typed.
--
-- NO COUNTRY CODE IS GUESSED. An earlier draft of this step read a bare ten
-- digits as +1. That is not a harmless default here: Bubaly ships it-IT, es-MX
-- and nine other catalogues, an Italian mobile typed the local way
-- ("312 345 6789") is ten digits with no leading zero, and "+13123456789" is a
-- real Chicago number — the provider would have accepted the family's urgent
-- text and delivered it to a stranger. The silent non-delivery that legacy row
-- already had is the lesser failure, and the parent sees an empty field and
-- re-enters the number in the form the placeholder and the action's own
-- refusal copy ask for.
--
-- Additive and replay-safe: the column is added only when absent, the normalize
-- step only touches rows that violate the contract, and the constraint is added
-- only when absent.

-- 1. Keep what was typed. Null for every row this migration does not change;
--    never read by the app — it exists so an operator asked "what did this
--    family have in that field" can answer, and so step 2 is reversible.
alter table public.family_contact_channels
  add column if not exists forward_to_phone_legacy text;
comment on column public.family_contact_channels.forward_to_phone_legacy is
  'The forward_to_phone value 0356 replaced when it normalized or cleared the row; null when the row was not changed. Never read by the app.';

-- 2. Normalize what is already stored, exactly as lib/contact-center/phone.ts
--    `normalizeFallbackPhone` does: a value that starts with '+' and holds only
--    digits and the spacing/punctuation people type between them keeps its
--    digits; anything else — no plus, letters, a leading zero after the plus,
--    too few or too many digits — becomes null.
update public.family_contact_channels c
   set forward_to_phone_legacy = c.forward_to_phone,
       forward_to_phone = case
         when c.forward_to_phone ~ '^\+[0-9[:space:]().-]+$'
          and regexp_replace(c.forward_to_phone, '[^0-9]', '', 'g') ~ '^[1-9][0-9]{7,14}$'
         then '+' || regexp_replace(c.forward_to_phone, '[^0-9]', '', 'g')
         else null
       end
 where c.forward_to_phone is not null
   and c.forward_to_phone !~ '^\+[1-9][0-9]{7,14}$';

-- 3. Enforce it from here on.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.family_contact_channels'::regclass
       and conname = 'family_contact_channels_forward_to_phone_e164'
  ) then
    alter table public.family_contact_channels
      add constraint family_contact_channels_forward_to_phone_e164
      check (forward_to_phone is null or forward_to_phone ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;
