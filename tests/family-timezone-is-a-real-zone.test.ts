import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFamilySchema, finalizeOnboardingSchema, previewCalendarImportSchema } from '@/lib/validation';
import { isValidTimezone } from '@/lib/time/zoned';

// `families.timezone` is the zone every wall-clock answer this app gives a
// family is computed from: when their routines fire, what "today" means, which
// doses the medication reminder counts as already taken.
//
// Every one of those goes through `Intl.DateTimeFormat`, which THROWS on an
// unknown zone — and every call site catches and degrades to UTC, by design, so
// that a bad zone cannot crash a page. The consequence is that a bad zone is
// indistinguishable from UTC, silently and permanently. Measured:
//
//     instant 2026-09-19T01:30Z
//     America/Los_Angeles   day 2026-09-18   offset -420 min
//     Mars/Olympus_Mons     day 2026-09-19   offset    0 min   ← identical to UTC
//
// The column is `text not null default 'UTC'` with no CHECK, and the family
// settings field is FREE TEXT with placeholder "America/Chicago". So "Central"
// or a typo like "Amercia/Chicago" saved, and the form said "Family profile
// updated".
//
// MEASURED, and it corrects the obvious assumption: `Intl` ACCEPTS "CST",
// "EST" and "US/Central". They are legacy fixed-offset aliases, so they do not
// fall back to UTC — they resolve to a zone that never observes DST, which is a
// different and subtler wrong-wall-clock outcome for a family that meant
// America/Chicago. This guard does not reject them: they ARE zones, and
// refusing a string Intl accepts would break anyone using one deliberately.
// Recorded here so the next reader does not assume the validator covers it.
//
// The asymmetry worth remembering: `previewCalendarImportSchema` has validated
// its timezone all along — its comment reads "malformed supplied input must not
// guess" — on a value that is PRESENTATION ONLY and never stored. The stricter
// rule was on the throwaway copy and the looser one on the durable record.
const BAD = ['Mars/Olympus_Mons', 'Central', 'Amercia/Chicago', 'not a zone', ''];
const GOOD = ['UTC', 'America/Chicago', 'America/Los_Angeles', 'Pacific/Auckland', 'Europe/London'];

describe('a family timezone has to be a zone that exists', () => {
  it('accepts real IANA zones', () => {
    for (const tz of GOOD) {
      expect(createFamilySchema.safeParse({ name: 'The Smiths', timezone: tz }).success, tz).toBe(true);
    }
  });

  it('refuses a string that is not a zone', () => {
    for (const tz of BAD) {
      expect(createFamilySchema.safeParse({ name: 'The Smiths', timezone: tz }).success, tz).toBe(false);
    }
  });

  it('refuses it through the onboarding schema too — that is the one that persists', () => {
    const base = {
      profile: { firstName: 'A', lastName: 'B', phone: '', email: 'a@b.com' },
      family: { name: 'The Smiths', timezone: 'Mars/Olympus_Mons' },
      details: { householdAdults: 2, householdChildren: 1, childAges: [4], goals: [] },
    };
    expect(finalizeOnboardingSchema.safeParse(base).success).toBe(false);
    expect(finalizeOnboardingSchema.safeParse({ ...base, family: { name: 'The Smiths', timezone: 'America/Chicago' } }).success).toBe(true);
  });

  it('still defaults to UTC when the field is absent', () => {
    const parsed = createFamilySchema.safeParse({ name: 'The Smiths' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.timezone).toBe('UTC');
  });

  it('the preview schema uses the SHARED validator, not a private copy of it', () => {
    // It inlined its own try/catch around Intl. Four private copies of
    // `escapeLike` are why two earlier fixes in this repository did not
    // propagate; one definition is the rule.
    const src = readFileSync('lib/validation.ts', 'utf8');
    expect(src).not.toMatch(/new Intl\.DateTimeFormat\('en-US', \{ timeZone: timezone \}\)/);
    expect(src).toMatch(/isValidTimezone/);
    expect(previewCalendarImportSchema.safeParse({ source: 'paste', events: [], timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
  });

  it('the write paths that bypass the schema validate too', () => {
    // The family settings field writes straight to PostgREST from the browser,
    // and the admin create action takes its own input. Neither goes through
    // createFamilySchema, so neither is covered by the cases above.
    expect(readFileSync('components/modules/family-module.tsx', 'utf8')).toMatch(/isValidTimezone\(tz\)/);
    expect(readFileSync('app/(app)/admin/actions.ts', 'utf8')).toMatch(/isValidTimezone\(timezone\)/);
  });

  it('the validator itself distinguishes the two', () => {
    for (const tz of GOOD) expect(isValidTimezone(tz), tz).toBe(true);
    for (const tz of BAD.filter((t) => t !== '')) expect(isValidTimezone(tz), tz).toBe(false);
  });

  it('accepts the legacy fixed-offset aliases, and that is deliberate', () => {
    // These resolve — to zones with no DST. Rejecting a string Intl accepts
    // would break a deliberate user; the cost is that this guard cannot tell a
    // family who typed "CST" from one who meant it.
    for (const tz of ['CST', 'EST', 'US/Central', 'GMT']) expect(isValidTimezone(tz), tz).toBe(true);
  });
});
