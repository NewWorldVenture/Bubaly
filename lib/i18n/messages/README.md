# Message catalogues

`en-US.json` is the source of truth. Its keys are the contract; every other file
is checked against it by `tests/i18n-catalogue-parity.test.ts`.

## Base catalogues

`de-DE`, `es-ES`, `fr-FR`, `it-IT`, `nl-NL`, `pt-PT` are full translations. A key
they haven't reached yet falls back to English, so a lagging translation renders
an untranslated product rather than a raw key.

## Regional overlays

`en-GB`, `es-MX`, `es-US`, `fr-CA` carry **only the keys where that region
genuinely differs** from its base, and inherit everything else through the chain
in `lib/i18n/messages.ts`:

    es-US → es-MX → es-ES → en-US
    es-MX → es-ES → en-US
    fr-CA → fr-FR → en-US
    en-GB → en-US

They are currently `{}`, and that is correct rather than unfinished: none of the
shipped keys differ between, say, Peninsular and Mexican Spanish. Regional
divergence shows up in prose — British *personalise* vs American *personalize*,
Mexican *celular* vs Peninsular *móvil* — so these files fill in as marketing and
long-form copy is translated. Adding invented differences to make the files look
complete would make the product worse, not more localised.

The locales still earn their place while empty: they drive date, number and
currency formatting through `Intl`, and they are what the picker offers.

## Adding a key

1. Add it to `en-US.json` with the exact English string.
2. Translate it in every base catalogue.
3. Override in a regional overlay only where the region really differs.
