# Family display clock verification

The header and idle photo frame now accept the family's timezone. The clock and date use the same validated zone; an invalid setting uses UTC consistently. The calendar date uses the active UI locale while the existing 12/24-hour and seconds preferences are preserved. The display component owner wires the same server-supplied zone to both surfaces.

Six actual React/Chromium tests in tests/e2e/display-clock.spec.ts pass. They execute the real clock, photo frame, ambient formatter and calendar/ICS helpers, with the browser set to Asia/Tokyo and all URLs fulfilled locally. Cases cover Los Angeles at the New Year boundary, a zone/locale change to Paris/French, the New York spring DST transition, invalid timezone fallback, photo-frame idle/wake behavior, and unmount. Scoped lint passes. The first harness attempt had an escaped regular-expression syntax error; replacing the relative-import resolver corrected that fixture, and no application failure is inferred from the failed setup.

This verifies rendered component time/date behavior and timer interactions under controlled browser time. Physical kiosk sleep, device clock drift, family settings persistence and the complete authenticated display journey remain separate verification.

## Integrated locale-contract correction

The full strict TypeScript gate caught that useLocale returns a Locale object, while the first fixtures supplied a string. Passing that object to Intl formatting could silently use the browser default. Both display call sites now pass locale.code. Clock tests execute the actual LocaleProvider/context and locale catalogue resolver with supplied message data; the grid fixture returns actual localeOrDefault objects and checks French date labels. The six clock and25 display browser checks pass after correction, plus scoped lint. A test helper tile ID parameter was explicitly typed as string. No type errors were suppressed; root is repeating the strict integrated gate.
