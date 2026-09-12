# Family display clock verification

The header and idle photo frame now accept the family's timezone. The clock and date use the same validated zone; an invalid setting uses UTC consistently. The calendar date uses the active UI locale while the existing 12/24-hour and seconds preferences are preserved. The display component owner wires the same server-supplied zone to both surfaces.

Six actual React/Chromium tests in tests/e2e/display-clock.spec.ts pass. They execute the real clock, photo frame, ambient formatter and calendar/ICS helpers, with the browser set to Asia/Tokyo and all URLs fulfilled locally. Cases cover Los Angeles at the New Year boundary, a zone/locale change to Paris/French, the New York spring DST transition, invalid timezone fallback, photo-frame idle/wake behavior, and unmount. Scoped lint passes. The first harness attempt had an escaped regular-expression syntax error; replacing the relative-import resolver corrected that fixture, and no application failure is inferred from the failed setup.

This verifies rendered component time/date behavior and timer interactions under controlled browser time. Physical kiosk sleep, device clock drift, family settings persistence and the complete authenticated display journey remain separate verification.
