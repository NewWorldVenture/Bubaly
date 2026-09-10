# Pasted onboarding calendar imports

This contract applies to `lib/onboarding/ics.ts` and the onboarding paste preview/Finish path. The sample generator, connected-calendar adapters, calendar sync parser, migration parser, provider consent, and quarantine policies are separate. Preview authenticates and may read dinner suggestions after successful parsing; it does not write calendar rows. Finish validates normalized pasted timestamps before profile, family, or calendar mutations and retains the existing ownership and receipt checks.

## Supported temporal forms

| Input | Interpretation |
| --- | --- |
| `DTSTART:20260910T130000Z` | Explicit UTC instant. |
| `DTSTART;TZID=America/New_York:20260910T090000` | Recognized IANA zone; quoted TZID parameters are accepted. |
| `DTSTART:20260910T090000` | Floating time anchored to the explicitly supplied family timezone. The preview discloses that choice. A missing choice is an error. |
| `DTSTART;VALUE=DATE:20260910` | Genuine all-day date. Its date identity stays unchanged; a bare eight-digit date remains accepted for compatibility. |
| `DTEND` | Exclusive, later than DTSTART, with a matching DATE/DATE-TIME type and floating/fixed form. |
| `DURATION` | Positive weeks, days, hours, minutes, and seconds. Calendar days resolve first in the event zone, then elapsed time is added. DATE events allow whole days/weeks only. |

Dates use valid Gregorian fields in years 0001–9999. Numeric UTC-offset suffixes, fractional ICS seconds, leap seconds, malformed values, duplicate temporal properties, DATE with TZID, UTC with TZID, both DTEND and DURATION, and overflowing/nonpositive durations fail the whole paste. Missing timed end/duration becomes an explicit point (`end = start`); missing all-day end retains the existing one-day behavior. This requires the separate zero-duration FirstBrief correction in PR #490.

The resolver follows RFC 5545's first occurrence for repeated local times and the preceding offset for nonexistent local times. If a gap advances the effective start, nominal duration arithmetic starts from that resolved local date/time. Pasted titles, locations, descriptions, UIDs, raw RRULE values, and event order retain the existing text decoding behavior; no guessed timezone suffix or custom-prefix stripping is performed.

## IANA declarations and limits

The runtime's IANA data supplies timezone offsets. Region identifiers and aliases must be recognized by `Intl`; bare identifiers additionally belong to the explicit list from IANA tzdb **2026c** [backward](https://data.iana.org/time-zones/tzdb/backward) and [etcetera](https://data.iana.org/time-zones/tzdb/etcetera). UTC/GMT and verified aliases such as Cuba, GB, and EST5EDT are supported. ICU-only ambiguous abbreviations such as CST/PST are rejected. Runtime IANA data versions may differ; supplied definitions must agree with the runtime for the imported times.

Normal IANA `VTIMEZONE` declarations may contain STANDARD/DAYLIGHT observances, DTSTART, TZOFFSETFROM/TZOFFSETTO, transition RDATE, and yearly RRULEs. The supported RRULE subset is YEARLY with INTERVAL=1, one BYMONTH, either one ordinal BYDAY or one BYMONTHDAY, and optional UTC UNTIL; omitted month/day default from DTSTART. Descriptive TZNAME/COMMENT and X-properties do not supply offset authority. Custom or unknown TZIDs, conflicting definitions, unsupported recurrence-rule forms, and declarations that do not cover the imported times fail explicitly.

Each imported start, end, and nominal-duration resolution point is verified against its applicable declaration offset and preceding transition. Declared transitions inside the imported range are checked too. Weekly samples additionally detect omitted longer seasonal cycles. This verifies imported endpoints and applicable transitions; it does not assert exhaustive equivalence at every unused historical instant or support arbitrary custom timezone rules. The short Boa Vista DST interval in October 2000 is covered by an intermediate-event regression.

Resource bounds are 200,000 pasted characters, 1,000 events, component nesting depth eight, 128 timezone definitions/formatters, 128 observances per definition, and 1,000 RDATE values per observance. For each supplied definition, the UTC calendar years containing the earliest and latest imported points may differ by at most 200. Date/duration arithmetic must remain finite and within the supported years. Titles/locations must fit the existing 200-character finalization fields. Exceeding a bound rejects the entire paste; no partial import or silent truncation is returned.

## Recurrence and preview ownership

RRULE is preserved in parsed data, but only the listed DTSTART occurrence is imported. The preview explicitly states in all seven locales that series are neither expanded nor saved as repeating events. Event-level RDATE, EXDATE, RECURRENCE-ID, and EXRULE are rejected because ignoring them would change the import's meaning. Recurrence expansion and arbitrary custom VTIMEZONE support remain follow-up work.

At the paste preview boundary, returned brief events have `recurring: false`, matching the stored `recurrence: none`. Preview revisits and Finish therefore do not promise recurring events “on autopilot” or count the associated five-minute benefit. Finish also suppresses that benefit for an older or modified browser flag. Raw parsed RRULEs, the pure `toBriefEvents` helper, demo/provider semantics, receipts, and business-key generation remain unchanged.

Timezone and recurrence disclosures are transient typed presentation metadata. They never enter session storage, business keys, or the Finish payload. They remain attached to the same owner and event array across preview revisits and billing-query changes. Reset, unmount, and user/family lifetime changes revoke stale responses and callbacks; owner changes also mask imported contents and completed brief data. A failed preview permits an explicit retry.

## Validation scope

The focused suites exercise pure parsing, actual preview/Finish actions with an in-memory database, normalized payload rejection before mutations, seven-locale error/disclosure rendering, owner/query/ABA lifetimes, and the separate point-event engine behavior. Actual React StrictMode/Chromium fixtures cover seven locales at 320/1280 widths, revisit/reset/Finish, stale responses, retained callbacks, and retries. Those fixtures double external server/provider boundaries; they do not claim a live provider import, deployed production verification, or broader RFC coverage.

Temporal semantics reference [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), sections 3.3.5, 3.3.6, 3.6.1, 3.6.5, 3.8.2.2, and 3.8.2.5.
