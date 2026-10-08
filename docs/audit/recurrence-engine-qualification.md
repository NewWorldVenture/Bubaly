# Recurrence engine qualification

This is a synthetic qualification of the actual `ical.js@2.2.1` registry tarball and a narrow adapter prototype, performed on 2026-10-07. It is not application integration, full RFC5545 acceptance, IANA database qualification, or production verification. Repository dependencies were not installed or changed for this investigation.

The future-engine inputs and **correct expected results** are in [calendar-source-fidelity.json](../../tests/fixtures/calendar-source-fidelity.json). These fixtures deliberately do not make observed library defects the expected application behavior. No failing runtime unit suite is introduced; the future engine must execute these contracts.

## Executed receipts

The isolated directory is `C:/Users/Daniel/AppData/Local/Temp/bubaly-ical-qualification-88d49b5df8ed40ffae233c47378cb337`. It contains `qualify.mjs`, the unpacked package, original tarball, separate `receipt-node22.json` / `receipt-node24.19.json`, and corresponding logs. All test inputs are synthetic, including VTIMEZONE observances covering only the stated historical windows.

| Runtime | Result | Meaning |
| --- | --- | --- |
| Node22.23.1 | 14/14 cases pass | Defect witnesses and narrow prototype/control assertions pass |
| Bundled Node24.19.0 | 14/14 cases pass | Same cases, separately executed; below declared24.21 |

These are **nine defect-witness cases plus five controls**, not fourteen repaired application behaviors. Each case runs in its own child with a five-second timeout and bounded output. A separate nonterminating-child control verifies a 150ms timeout actually terminates the child. The prototype has an explicit candidate-budget refusal; exhaustion never returns an empty success.

Package provenance: `npm pack ical.js@2.2.1 --ignore-scripts` in the isolated directory; package SHA1 `f06fe9b32498d948893ec994e6964379dac6a907`, SHA256 `36482280d62cc50f0adddb0587612cff32b96df18eb9e2071ec9929c2e7b3107`. Reproduce with the unpacked package beside the harness: `node qualify.mjs`. Passing a case ID executes that case alone. The harness and receipts remain local Temp evidence, not a durable repository test runner.

## Observed defects and controls

| Case | Actual unmodified ICAL.js behavior | Correct contract / prototype result |
| --- | --- | --- |
| New York daily02:30, COUNT3 from2025-03-08 | Includes nonexistent March9 and stops March10 | March8,10,11; generated gap consumes no COUNT |
| Lord Howe daily02:15, COUNT3 from2024-10-05 | Includes nonexistent October6 | October5,7,8, respecting the half-hour change |
| Apia daily12:00, COUNT3 from2011-12-29 | Exposes only December29,31 after consuming the skipped date | December29,31, January1 |
| YEARLY BYYEARDAY1 + BYMONTH1 | Throws `Invalid BYYEARDAY rule` | January1 in2025 and2026; **not corrected by this prototype** |
| RDATE VALUE=PERIOD with09:00–12:00 | Event occurrence-details path throws `occurrence.convertToZone is not a function` | Original09:00 identity and particular12:00 end retained |
| Unrelated UID detached override | Default Event construction lets UID B move UID A's occurrence to15:00 | Explicit same-UID grouping and strict exceptions retain A at09:00 and reject B |
| Unknown TZID | Falls back to floating time, offset0; conversion looks like09:00Z | Explicit unresolved-TZID refusal |
| Explicit New York gap/fold | Gap resolves06:30Z; fold resolves06:30Z | Gap uses pre-gap offset07:30Z; fold uses first instant05:30Z |
| DAILY BYHOUR2,3 BYMINUTE30 BYSETPOS1 across gap | Returns both times on March8; positional selection is ineffective | March8 at02:30, March9 at03:30, March10 at02:30 |
| UTC UNTIL boundary | Correctly excludes March9 at19:00 New York beyond22:00Z | Unmodified-library positive control passes |
| EXDATE after corrected COUNT | Adapter control | Generated March8,10,11; excluding March10 leaves8,11 without replenishing COUNT |
| Negative DAILY BYSETPOS | Adapter control | Last valid daily candidate03:30; original component source remains unchanged |
| Candidate budget / child timeout | Harness controls | Explicit incomplete/error refusal and actual child termination |

The UTC UNTIL concern previously identified by source inspection concerned **rruleJS**, not this ICAL.js control. This investigation did not execute rruleJS.

## Prototype boundary and remaining work

The prototype uses actual ICAL component parsing, rule cloning, recurrence iteration, Period objects and strict Event exceptions. Its timezone resolver expands the fixture VTIMEZONE observances with ICAL iterators, computes transition instants using TZOFFSETFROM, and inverts civil times against the resulting offsets. It chooses the first valid instant in a fold, detects generated gaps, and separately applies the RFC pre-gap-offset rule to explicit values. This avoids trusting permissive library timezone normalization for those operations.

For ordinary rules, the prototype removes COUNT/UNTIL only on an in-memory clone, resolves generated candidates, discards gaps, compares actual instants to UTC UNTIL, and advances the original COUNT on valid RRULE instances. EXDATE follows COUNT. PERIOD output retains its own original start identity and explicit end.

For the tested **DAILY BYSETPOS** combination, the clone also removes positional selection. The adapter groups source-zone candidates by recurrence day, removes invalid local candidates, then selects positive/negative positions and advances COUNT. A simple post-expansion gap filter cannot repair this case. General frequency periods, cross-period defaults, sparse/impossible rules and all legal BY* intersections remain unqualified; the BYYEARDAY witness intentionally stays open. The fixture expectations require a future implementation rather than permission to reject otherwise valid RFC input.

The fixture timezone resolver is not a production timezone service: coverage and expansion years are intentionally bounded to these historical inputs. A production engine needs validated embedded VTIMEZONE precedence, a pinned IANA fallback dataset, explicit unresolved-zone errors, complete range/coverage admission and per-calendar isolation. Full PERIOD recurrence-set merging, moved/cancelled detached overrides, THISANDFUTURE, exact-versus-nominal duration, export/reimport preservation and complete BY* conformance still require implementation and execution. Worker deadlines must cover internal library loops as well as emitted-candidate budgets.

For source-preserving parser integration, `ICAL.parse` returns raw jCal; property metadata and raw jCal values can be inspected before `getFirstValue`/`getValues` decorate dates. Retain original ICS bytes as well: jCal normalizes lexical representations and is not a lossless raw-source archive. Validate TZID metadata before decoration, preserve parameters/value types, and group detached components explicitly by UID.

## Primary sources

- [RFC5545 §3.3.5](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5): explicit gap interpretation and first fold occurrence.
- [RFC5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10): valid BY* combinations, generated-gap omission, positional selection and COUNT/UNTIL.
- [RFC5545 §3.8.5](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5): recurrence-set inclusion/exclusion and occurrence duration.
- [Pinned ICAL.js iterator](https://github.com/kewisch/ical.js/blob/v2.2.1/lib/ical/recur_iterator.js), [time](https://github.com/kewisch/ical.js/blob/v2.2.1/lib/ical/time.js), [Event](https://github.com/kewisch/ical.js/blob/v2.2.1/lib/ical/event.js), [expansion](https://github.com/kewisch/ical.js/blob/v2.2.1/lib/ical/recur_expansion.js), [Period](https://github.com/kewisch/ical.js/blob/v2.2.1/lib/ical/period.js).
- [Official timezone guidance](https://github.com/kewisch/ical.js/wiki/Common-Use-Cases): stock ICAL.js does not include the IANA timezone database.

## Standalone repository foundation (2026-10-08)

The repository now has a separate bounded source-rule engine, source-clock resolver and source-occurrence set materializer. These are synthetic source foundations; no importer, event reader, action or platform export calls them. They do not change the older ICAL.js defect-witness receipts above.

The rule engine follows the RFC frequency expansion/filter table for SECONDLY through YEARLY, selector intersections, ordinal weekdays, week starts/year boundaries, positional selection and typed UNTIL. Generated gaps are removed before positional selection and COUNT. The original explicit DTSTART has a separate resolver. RDATE and EXDATE are handled by the occurrence layer, with EXDATE after RRULE COUNT. Exhausted work/output bounds throw and never return an incomplete prefix.

The clock resolver gives an embedded VTIMEZONE precedence over an IANA name. It derives observance transition instants from TZOFFSETFROM, validates offset chains, handles explicit gaps with the pre-transition offset and selects the first instant in a fold. Generated gaps return no candidate. IANA fallback uses host Intl/ICU; no repository-pinned TZDB or complete historical timezone qualification is claimed. Floating and DATE projections require explicit timezone context. Rule expansion, lazy compilation of multiple embedded zones and event-set traversal share enclosing work budgets.

The occurrence layer retains typed original identity while combining DTSTART, RRULE, ordinary RDATE and PERIOD values, exclusions and explicit overrides. A moved occurrence keeps its original recurrence ID. Timed DTEND elapsed duration is distinct from nominal DURATION days/weeks followed by elapsed hours/minutes/seconds. DATE intervals retain exclusive Gregorian end dates before contextual timezone projection. This DATE-domain interpretation is an inference from RFC5545 sections3.3.4 and3.6.1, rather than treating the selected display timezone as part of the original DATE source; section3.8.5.3 retains exact elapsed DTEND behavior for timed instances. RANGE support is bounded to shifts within the same original civil clock; cross-clock and unresolved revision/cancellation combinations refuse explicitly.

Current limits remain visible: leap-second materialization/stepping, subdaily DATE rules and explicit-gap DTSTART combined with BYSETPOS need further qualification. Scheduling METHOD:CANCEL requires a separate revision contract. Nested recurrence on overrides, conflicting PERIOD durations and ambiguous cross-clock recurrence identities are not normalized silently. These refusals do not count as completion of otherwise valid source-calendar support.

Persisted cancelled-master and detached-only groups still need a source archive contract; the reserved publication endpoint currently requires a live master projection. Ordinary table updates remain outside its metadata erasure invariant. Complete source-aware reads, native/imported action policy, import/publication and export wiring, source revision selection, old lossy-row repair and production release remain open.

Final local acceptance on 2026-10-08: **296 tests in six source suites pass in each of UTC, America/Los_Angeles and Asia/Tokyo**, comprising187 source model/parser/export cases,44 rule cases,36 clock cases and29 occurrence-set cases. Full nonincremental TypeScript with8GiB heap and scoped ESLint pass. Ten audit/register cases and the451-file migration filename audit pass. Independent review re-executes four previously failing identity/duration/coverage witnesses successfully; a separate duration review passes11controls before the final parameter-admission-only tightening. This is local Node24.19 evidence, below declared CI24.21, and does not replace fresh hosted CI or production verification.
