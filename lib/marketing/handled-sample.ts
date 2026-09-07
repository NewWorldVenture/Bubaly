// lib/marketing/handled-sample.ts — the ILLUSTRATIVE sample behind the
// homepage's "Bubaly Handled" band.
//
// Everything here is fiction and is badged as such wherever it renders
// (handledProof.sampleBadge). Two rules keep it honest:
//
//   1. The NUMBERS on the sample Daily Brief card are not typed in. They come
//      from the app's own composer, buildFirstBrief (lib/onboarding/first-brief.ts),
//      run over SAMPLE_WEEK at SAMPLE_NOW — the same code a new family sees in
//      onboarding. The COPY around those numbers is a catalogue key with
//      placeholders; the composer's own English sentence is never rendered on
//      a public page, where it would appear untranslated.
//   2. The ledger shows only actions the product performs — calendar events,
//      reminders, lists, flyer imports, a partial run, a decision queued for a
//      parent. Nothing purchased, paid or confirmed with a third party.
//
// The rows use their OWN type rather than CompletedItem (lib/home/today.ts):
// that type has no "waiting for a parent" state, and the sample needs one.

import { buildFirstBrief, type BriefEvent } from '@/lib/onboarding/first-brief';

export type HandledSampleState = 'done' | 'partial' | 'awaiting_ok';

export type HandledSampleRow = {
  key: string;
  titleKey: string;
  detailKey: string;
  state: HandledSampleState;
  steps?: { done: number; total: number };
  /** ISO timestamp, fixed so the sample renders the same on every request. */
  at: string;
};

export const HANDLED_SAMPLE: HandledSampleRow[] = [
  {
    key: 'meals-to-list',
    titleKey: 'handledProof.sample1Title',
    detailKey: 'handledProof.sample1Detail',
    state: 'done',
    steps: { done: 8, total: 8 },
    at: '2026-09-06T18:10:00.000Z',
  },
  {
    key: 'field-trip-form',
    titleKey: 'handledProof.sample2Title',
    detailKey: 'handledProof.sample2Detail',
    state: 'done',
    at: '2026-09-05T16:40:00.000Z',
  },
  {
    key: 'soccer-reminder',
    titleKey: 'handledProof.sample3Title',
    detailKey: 'handledProof.sample3Detail',
    state: 'done',
    at: '2026-09-05T07:30:00.000Z',
  },
  {
    key: 'subscription-sweep',
    titleKey: 'handledProof.sample4Title',
    detailKey: 'handledProof.sample4Detail',
    state: 'awaiting_ok',
    at: '2026-09-07T06:05:00.000Z',
  },
  {
    key: 'plumber-booking',
    titleKey: 'handledProof.sample5Title',
    detailKey: 'handledProof.sample5Detail',
    state: 'partial',
    steps: { done: 6, total: 8 },
    at: '2026-09-06T11:20:00.000Z',
  },
];

/** A fixed "now" (a Monday, 13:00 UTC) so the brief is deterministic. */
export const SAMPLE_NOW = '2026-09-07T13:00:00.000Z';

/**
 * The fictional family's week. Authored so that, at SAMPLE_NOW, the composer
 * finds exactly three things today and one clash (the dentist overlaps
 * football practice) — tests/marketing-handled-honesty.test.ts pins both, and
 * the singular "clash" in the headline copy depends on it.
 */
export const SAMPLE_WEEK: BriefEvent[] = [
  { title: 'School drop-off', start: '2026-09-07T08:00:00.000Z', end: '2026-09-07T08:20:00.000Z', location: 'Maple Street Primary', recurring: true },
  { title: 'Dentist — Emma', start: '2026-09-07T15:30:00.000Z', end: '2026-09-07T16:15:00.000Z', location: 'Riverside Dental' },
  { title: 'Football practice — Noah', start: '2026-09-07T16:00:00.000Z', end: '2026-09-07T17:00:00.000Z', location: 'Elm Park', recurring: true },
  { title: 'Plumber — kitchen tap', start: '2026-09-08T14:00:00.000Z', end: '2026-09-08T15:00:00.000Z', location: 'Home' },
  { title: 'Piano lesson — Emma', start: '2026-09-08T16:00:00.000Z', end: '2026-09-08T16:45:00.000Z', recurring: true },
  { title: 'Parent-teacher evening', start: '2026-09-09T18:00:00.000Z', end: '2026-09-09T19:00:00.000Z', location: 'Maple Street Primary' },
  { title: 'Field trip — permission slip due', start: '2026-09-10T00:00:00.000Z', allDay: true },
  { title: 'Football match — Noah', start: '2026-09-12T09:00:00.000Z', end: '2026-09-12T10:30:00.000Z', location: 'Elm Park' },
];

export type SampleBriefNumbers = {
  /** Things on the timeline today. */
  today: number;
  /** Overlapping timed events this week. */
  clashes: number;
  /** Ledger rows in the `done` state. */
  handled: number;
  /** The composer's own time-saved estimate for the week, in minutes. */
  minutes: number;
};

/**
 * The numbers the sample brief card renders — computed, never typed. The
 * component puts them into handledProof.sampleBriefHeadline's placeholders.
 */
export function sampleBriefNumbers(): SampleBriefNumbers {
  const brief = buildFirstBrief(SAMPLE_WEEK, new Date(SAMPLE_NOW));
  return {
    today: brief.todayCount,
    clashes: brief.conflicts.length,
    handled: HANDLED_SAMPLE.filter((row) => row.state === 'done').length,
    minutes: brief.timeSavedMinutes,
  };
}
