import { describe, expect, it } from 'vitest';
import { buildFirstBrief, briefSummary, type BriefEvent, type FirstBrief } from '@/lib/onboarding/first-brief';
import { formatFirstBrief, firstBriefDisplaySchema, briefConflictDisplaySchema, briefActionDisplaySchema, briefOpportunityDisplaySchema } from '@/lib/onboarding/first-brief-display';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { briefSchema, buildBrief } from '@/lib/briefing/build';

const NOW = new Date('2026-09-10T00:00:00Z');
const TITLE = 'Practice {weekday} : {count} — <script> & "today"';
const DINNER = { title: 'Dinner {title}', cuisine: 'Cuisine unchanged', effort: 'quick' as const, prepMinutes: 20, description: '<b>Imported description</b>' };
const events: BriefEvent[] = [
  { title: 'School closed', start: '2026-09-09T00:00:00Z', allDay: true, location: 'School {day}' },
  { title: TITLE, start: '2026-09-09T23:30:00Z', end: '2026-09-10T01:00:00Z', location: 'Field {time}', recurring: true },
  { title: 'Appointment', start: '2026-09-10T00:15:00Z', end: '2026-09-10T01:30:00Z' },
  { title: 'Tomorrow', start: '2026-09-10T15:00:00Z', location: 'Office' },
];
const fixture = () => buildFirstBrief(events, NOW, [DINNER], 'America/New_York');
const render = (brief: FirstBrief, locale: LocaleCode = 'de-DE') => formatFirstBrief(brief, { locale, t: (key, params) => translate(getMessages(locale), key, params) });
const expected = [
  ['en-US', 'All day', 'Today', 'Wednesday', '7:30 PM', '3 events', '1 clash'],
  ['de-DE', 'Ganztägig', 'Heute', 'Mittwoch', '19:30', '3 Termine', '1 Überschneidung'],
  ['es-ES', 'Todo el día', 'Hoy', 'miércoles', '19:30', '3 eventos', '1 solapamiento'],
  ['fr-FR', 'Toute la journée', 'Aujourd’hui', 'mercredi', '19:30', '3 événements', '1 chevauchement'],
  ['it-IT', 'Tutto il giorno', 'Oggi', 'mercoledì', '19:30', '3 eventi', '1 sovrapposizione'],
  ['nl-NL', 'Hele dag', 'Vandaag', 'woensdag', '19:30', '3 afspraken', '1 overlap'],
  ['pt-PT', 'Todo o dia', 'Hoje', 'quarta-feira', '19:30', '3 eventos', '1 sobreposição'],
] as const;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(brief: FirstBrief): FirstBrief {
  const copy = structuredClone(brief);
  delete copy.display;
  for (const rows of [copy.conflicts, copy.actions, copy.opportunities]) for (const row of rows) delete row.display;
  return copy;
}
function textOnly(brief: FirstBrief) {
  return { headline: brief.headline, timeline: brief.timeline.map(({ timeLabel }) => ({ timeLabel })),
    conflicts: brief.conflicts.map(({ dayLabel, overlapLabel }) => ({ dayLabel, overlapLabel })),
    actions: brief.actions.map(({ label, detail }) => ({ label, detail })), opportunities: brief.opportunities.map(({ label, detail }) => ({ label, detail })) };
}

describe('first brief semantic display', () => {
  it.each(expected)('renders %s without translating imported data or substituting its braces', (locale, allDay, today, weekday, time, eventCount, clashCount) => {
    const brief = freeze(fixture());
    const before = JSON.stringify(brief), summary = JSON.stringify(briefSummary(brief));
    const view = render(brief, locale);
    expect(view.headline).toContain(weekday);
    expect(view.headline).toContain(eventCount);
    expect(view.headline).toContain(clashCount);
    expect(view.timeline.map(item => item.timeLabel)).toEqual([allDay, time, locale === 'en-US' ? '8:15 PM' : '20:15']);
    expect(view.conflicts).toEqual([{ dayLabel: today, overlapLabel: locale === 'en-US' ? '8:15 PM–9:00 PM' : '20:15–21:00' }]);
    expect(view.actions[0].detail).toContain(TITLE);
    expect(view.actions[0].detail).toContain('Appointment');
    expect(view.actions.at(-1)?.detail).toContain(TITLE);
    expect(JSON.stringify(view)).not.toContain('firstBriefDisplay.');
    expect(JSON.stringify(brief)).toBe(before);
    expect(JSON.stringify(briefSummary(brief))).toBe(summary);
    expect(brief.dinnerIdeas).toEqual([DINNER]);
    expect(brief.timeline[1].location).toBe('Field {time}');
    expect(view).not.toHaveProperty('todayCount');
    expect(view).not.toHaveProperty('dinnerIdeas');
  });

  it('records facts alongside unchanged canonical values, IDs, order and durable summary', () => {
    const brief = fixture();
    expect(brief.display).toEqual({ version: 1, timezone: 'America/New_York', dayKey: '2026-09-09', headline: 'conflicts' });
    expect(brief.actions.map(a => [a.id, a.display])).toEqual([
      [`conflict:${TITLE}:Appointment`, { kind: 'conflict', conflictIndex: 0 }],
      ['location:Appointment:2026-09-10T00:15:00Z', { kind: 'location', title: 'Appointment', dayKey: '2026-09-09' }],
      [`prep:${TITLE}`, { kind: 'prep', timelineIndex: 1 }],
    ]);
    expect(brief.opportunities.map(o => [o.id, o.minutes, o.display])).toEqual([
      ['conflicts', 15, { kind: 'conflicts', count: 1 }], ['week', 6, { kind: 'week', count: 3 }], ['recurring', 5, { kind: 'recurring', count: 1 }],
    ]);
    expect(briefSummary(brief)).toEqual({
      headline: "Here's your Wednesday — 3 events, 1 clash to resolve.", todayCount: 3, weekCount: 3, conflictCount: 1, actionCount: 3, dinnerCount: 1, timeSavedMinutes: 26,
      opportunities: [{ label: '1 clash caught for you', minutes: 15 }, { label: 'Your week, already organized', minutes: 6 }, { label: '1 recurring event on autopilot', minutes: 5 }],
    });
    expect(JSON.stringify(briefSummary(brief))).toBe(JSON.stringify(briefSummary(canonical(brief))));
  });

  it('keeps all-day prep untimed and can format the same brief in a new locale', () => {
    const brief = buildFirstBrief([events[0]], NOW, [], 'America/New_York');
    expect(brief.actions[0].display).toEqual({ kind: 'prep', timelineIndex: 0 });
    expect(render(brief).actions[0].detail).toBe('Zuerst steht an: School closed.');
    expect(render(brief, 'fr-FR').actions[0].detail).toBe('Pour commencer : School closed.');
    expect(brief.actions[0].detail).toBe('First up: School closed.');
  });

  it.each([0, 1, 2, 1000])('formats %i events using locale plural rules and numbers', (count) => {
    const many = Array.from({ length: count }, (_, i) => ({ title: String(i), start: '2026-09-09T00:00:00Z', allDay: true }));
    const brief = buildFirstBrief(many, NOW, [], 'America/New_York');
    if (!count) { expect(render(brief).headline).toBe('Alles ist eingerichtet — tragen Sie Ihre ersten Termine ein, und Bubaly übernimmt den Rest.'); return; }
    expect(render(brief).headline).toContain(count === 1 ? '1 Termin' : count === 1000 ? '1.000 Termine' : '2 Termine');
    expect(brief.todayCount).toBe(count);
  });

  it('does not recover opportunity counts from capped minutes or IDs', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ title: `Event ${i}`, start: new Date(NOW.getTime() + i * 2 * 3600_000).toISOString(), recurring: true, location: 'Office' }));
    const brief = buildFirstBrief(many, NOW);
    expect(brief.opportunities.find(o => o.id === 'week')?.minutes).toBe(80);
    const view = render(brief, 'en-US');
    expect(view.opportunities.find(o => o.label === 'Your week, already organized')?.detail).toBe('45 events sorted into one shared timeline.');
    expect(view.opportunities[0].label).toBe('45 recurring events on autopilot');
  });

  it('uses the same source conflict references after ranking and respects plural opportunity counts', () => {
    const brief = buildFirstBrief(['A', 'B', 'C'].map(title => ({ title, start: '2026-09-09T23:30:00Z', recurring: true })), NOW, [], 'America/New_York');
    expect(brief.actions).toHaveLength(6);
    expect(brief.actions.slice(0, 3).map(action => action.display)).toEqual([0, 1, 2].map(conflictIndex => ({ kind: 'conflict', conflictIndex })));
    const view = render(brief);
    expect(view.actions.slice(0, 3).map(action => action.detail)).toEqual([
      'A überschneidet sich mit B (19:30–20:30). Entscheiden Sie, wer was übernimmt.',
      'A überschneidet sich mit C (19:30–20:30). Entscheiden Sie, wer was übernimmt.',
      'B überschneidet sich mit C (19:30–20:30). Entscheiden Sie, wer was übernimmt.',
    ]);
    expect(view.opportunities.map(item => item.label)).toEqual(['3 Überschneidungen für Sie erkannt', '3 wiederkehrende Termine auf Autopilot', 'Ihre Woche ist bereits organisiert']);
  });

  it('handles zero events today when the planning horizon is not empty', () => {
    const brief = buildFirstBrief([events[3]], NOW, [], 'America/New_York');
    expect(brief.display?.headline).toBe('clear');
    expect(render(brief, 'en-US').headline).toBe('Here’s your Wednesday — 0 events, and you’re in good shape.');
    expect(render(brief, 'fr-FR').headline).toBe('Votre mercredi : 0 événement, et tout est bien organisé.');
  });

  it('leaves legacy briefs readable without metadata and never parses their English labels or IDs', () => {
    const brief = canonical(fixture());
    brief.headline = 'Legacy headline {day}'; brief.actions[0].id = 'not:a:recoverable:id';
    expect(render(freeze(brief))).toEqual(textOnly(brief));
  });

  it.each([null, { version: 2, timezone: 'UTC', dayKey: '2026-09-09', headline: 'clear' },
    { version: 1, timezone: 'Invalid/Zone', dayKey: '2026-09-09', headline: 'clear' },
    { version: 1, timezone: 'UTC', dayKey: '2026-02-30', headline: 'clear' },
    { version: 1, timezone: 'UTC', dayKey: '2026-09-09', headline: 'clear', authorize: true },
  ])('falls back when display context is malformed: %j', (display) => {
    const brief = fixture(); Object.assign(brief, { display });
    expect(render(brief)).toEqual(textOnly(brief));
  });

  it('invalidates only the affected headline, item or reference', () => {
    const brief = fixture();
    Object.assign(brief.display!, { headline: 'unknown' });
    Object.assign(brief.conflicts[0].display!, { overlapEnd: '2026-09-09T00:00:00Z' });
    Object.assign(brief.opportunities[0].display!, { count: -1 });
    const view = render(brief);
    expect(view.headline).toBe(brief.headline);
    expect(view.timeline[0].timeLabel).toBe('Ganztägig');
    expect(view.conflicts[0]).toEqual(textOnly(brief).conflicts[0]);
    expect(view.actions[0]).toEqual(textOnly(brief).actions[0]);
    expect(view.actions[1].label).toBe('Einen Ort hinzufügen');
    expect(view.opportunities[0]).toEqual(textOnly(brief).opportunities[0]);
    expect(view.opportunities[1].label).toBe('Ihre Woche ist bereits organisiert');
  });

  it.each([{ kind: 'conflict', conflictIndex: 99 }, { kind: 'conflict', conflictIndex: -1 }, { kind: 'conflict', conflictIndex: 0.5 },
    { kind: 'prep', timelineIndex: 0 }, { kind: 'conflict', conflictIndex: 0, label: 'Injected' },
  ])('does not guess a missing or invalid action reference: %j', (display) => {
    const brief = fixture(); Object.assign(brief.actions[0], { display });
    expect(render(brief).actions[0]).toEqual(textOnly(brief).actions[0]);
  });

  it('falls back for a bad prep instant while formatting unrelated all-day items', () => {
    const brief = fixture(); brief.timeline[1].start = 'not a date';
    const view = render(brief);
    expect(view.timeline[1].timeLabel).toBe(brief.timeline[1].timeLabel);
    expect(view.timeline[0].timeLabel).toBe('Ganztägig');
    expect(view.actions.at(-1)).toEqual(textOnly(brief).actions.at(-1));
  });

  it('validates generated descriptors and retains them through the existing aggregate validator', () => {
    const brief = buildBrief({ kind: 'daily', now: NOW, events, dinnerCandidates: [DINNER], snapshot: {}, completedRuns: [], activity: [] }, 'America/New_York');
    expect(firstBriefDisplaySchema.safeParse(brief.calendar.display).success).toBe(true);
    expect(brief.calendar.conflicts.every(c => briefConflictDisplaySchema.safeParse(c.display).success)).toBe(true);
    expect(brief.calendar.actions.every(a => briefActionDisplaySchema.safeParse(a.display).success)).toBe(true);
    expect(brief.calendar.opportunities.every(o => briefOpportunityDisplaySchema.safeParse(o.display).success)).toBe(true);
    const parsed = briefSchema.parse(brief);
    expect(parsed.calendar).toEqual(brief.calendar);
  });
});

describe('localized dates retain generation timezone semantics', () => {
  it.each([
    ['2026-03-07T23:30:00-05:00', '2026-03-08T22:00:00-04:00', '2026-03-08T22:30:00-04:00', 'Morgen', '22:30–23:00'],
    ['2026-10-31T23:30:00-04:00', '2026-11-01T01:15:00-04:00', '2026-11-01T01:30:00-04:00', 'Morgen', '1:30–1:15'],
    ['2026-09-09T12:00:00-04:00', '2026-09-11T10:00:00-04:00', '2026-09-11T10:30:00-04:00', 'Freitag', '10:30–11:00'],
  ])('labels calendar-relative days across transitions: %s', (now, first, second, day, range) => {
    const brief = buildFirstBrief([{ title: 'A', start: first }, { title: 'B', start: second }], new Date(now), [], 'America/New_York');
    expect(render(brief).conflicts[0]).toEqual({ dayLabel: day, overlapLabel: range });
  });
  it('honors explicit offsets ahead of UTC and preserves locale-independent dinner selection', () => {
    const brief = buildFirstBrief([{ title: 'Morning', start: '2026-09-10T08:00:00+09:00' }], new Date('2026-09-09T22:30:00Z'), [DINNER], 'Asia/Tokyo');
    expect(render(brief).headline).toContain('Donnerstag'); expect(render(brief).timeline[0].timeLabel).toBe('8:00');
    expect(render(brief, 'en-US').timeline[0].timeLabel).toBe('8:00 AM'); expect(brief.dinnerIdeas).toEqual([DINNER]);
  });
});
