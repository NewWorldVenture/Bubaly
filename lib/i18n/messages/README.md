# Message catalogues

`en-US.json` is the source of truth. Its keys are the contract, and
`tests/an-empty-locale-says-it-is-a-placeholder.test.ts` is what holds every
other file to it.

This line used to name a file called `i18n-catalogue-parity.test.ts`. **No such
file has ever existed** under `tests/` — so the README pointed confidently at a
test nobody wrote, for a property nothing checked, and so did
`lib/i18n/messages.ts`. Both are fixed. (The dead name is written without its
directory here on purpose: a `tests/…` path in these files is read as a promise
that the file is there, and the test below checks every one of them.)
`tests/i18n-catalogue-integrity.test.ts` is real, but it checks entity, escape,
placeholder, orphan and script hygiene, not coverage; every one of its loops runs
over `Object.entries()` and therefore passes vacuously on an empty file.

## Base catalogues

`de-DE`, `es-ES`, `fr-FR`, `it-IT`, `nl-NL`, `pt-PT` are full translations — and
**"full" is checked**, not asserted. `tests/an-empty-locale-says-it-is-a-placeholder.test.ts`
holds every locale that is *not* declared a placeholder to every key in
`en-US.json`, because a locale this repo advertises as a translation ought to be
one.

The runtime stays forgiving regardless: a key a translation had not reached would
fall back to English through the merge in `lib/i18n/messages.ts`, so a gap
renders an untranslated product rather than a raw key. That is the safety net,
not the plan — step 2 of *Adding a key* below is what keeps it unused.

## Regional overlays

`en-GB`, `es-MX`, `es-US`, `fr-CA` carry **only the keys where that region
genuinely differs** from its base, and inherit everything else through the chain
in `lib/i18n/messages.ts`:

    es-US → es-MX → es-ES → en-US
    es-MX → es-ES → en-US
    fr-CA → fr-FR → en-US
    en-GB → en-US

All four are currently `{}` — three bytes each — and that is a deliberate
placeholder rather than an unfinished translation. Adding invented differences to
make the files look complete would make the product worse, not more localised.

**They are declared as placeholders in code, not just described here.**
`PLACEHOLDER_LOCALES` in `lib/i18n/messages.ts` names exactly these four, and
`tests/an-empty-locale-says-it-is-a-placeholder.test.ts` checks the declaration
both ways: a locale named there must really be empty, and a locale not named
there must really carry every English key. So an empty catalogue cannot be
shipped quietly, and filling one in forces the declaration to be updated.

**What a reader of one of these four actually gets.** Merged down the chain the
map is complete before a single lookup happens, so nothing renders a raw key and
no page is blank — but the merged result is byte-identical to what it inherits.
Choosing *English (United Kingdom)* gives en-US's words; choosing *Español
(México)* gives es-ES's words. Formatting is the part that really changes,
because `Intl` follows the locale CODE and not the catalogue: a British reader
does get `14 Jul 2026` and `£`. So the honest description is British numbers
around American words, and that mixture is the cost of leaving these empty.

That is also why the four keep their place in the picker: the choice does
something real, just less than its name suggests. Regional divergence shows up in
prose — British *personalise* vs American *personalize*, Mexican *celular* vs
Peninsular *móvil* — so these files fill in as marketing and long-form copy is
translated.

## Adding a key

1. Add it to `en-US.json` with the exact English string.
2. Translate it in every base catalogue.
3. Override in a regional overlay only where the region really differs.
