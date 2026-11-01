import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { between } from './helpers/source-order';

// PERF-001. /dashboard/calendar moved what was on screen while it loaded:
// cumulative layout shift 0.35 at 1280x800 and 0.08 on a 390 px phone.
//
// - The Connect Outlook and Connect Google controls render once their status
//   probes answer. Each one arriving widened the header's action row, its
//   title block wrapped, and the week below moved down: 40 px, then 80 px.
//   Until a probe answers, an invisible stand-in with the control's own glyph
//   and label holds its place. It is aria-hidden and has no href or handler,
//   so the probe-unanswered state still offers nothing to press
//   (tests/calendar-connect-outlook.test.ts).
// - A three-card list stood in for the whole grid while the window loaded.
//   From md the week grid draws all 24 hours, 1,600 px, so the footer and the
//   busyness map below it jumped down the page when it arrived. The stand-in
//   reserves the grid's hours from md, and below md it is one card, about the
//   height of an empty day.
const mod = readFileSync('components/modules/calendar-module.tsx', 'utf8');

describe('the calendar holds its layout while it loads', () => {
  it.each([
    ['Outlook', '{outlookStatus === null && (', '{outlookStatus?.connected === false && (', '{outlookStatus?.connected === true && (', "<OutlookGlyph /> {tr('calendar.connectOutlook')}"],
    ['Google', '{gcalConnected === null && (', '{gcalConnected === false && (', '{gcalConnected && (', "<GoogleGlyph /> {tr('calendar.connectGoogle')}"],
  ])('an unanswered %s probe holds its Connect control\'s place, invisibly', (_provider, unanswered, connect, connected, face) => {
    const standIn = between(mod, unanswered, connect);
    expect(standIn).toContain('<span aria-hidden="true" className="btn-inline invisible">');
    expect(standIn).toContain(face);
    expect(standIn).not.toContain('href=');
    expect(standIn).not.toContain('onClick');
    // The same face as the control that replaces it, so its width is the control's.
    expect(between(mod, connect, connected)).toContain(face);
  });

  it("reserves the week grid's 24 hours from md while the window loads", () => {
    const standIn = between(mod, '{loading ? <>', ': gridError ?');
    expect(standIn).toContain('<SkeletonList count={1} className="flex-1 p-4 md:hidden" />');
    expect(standIn).toContain('<div className="hidden flex-1 md:block" style={{ minHeight: HOURS.length * HOUR_HEIGHT }}>');
    // The day columns it stands in for draw the same hours.
    expect(between(mod, '{/* Day columns */}', '{/* Hour lines */}')).toContain('style={{ minHeight: HOURS.length * HOUR_HEIGHT }}');
  });
});
