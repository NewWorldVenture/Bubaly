import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildHomeBrief, homeBriefSummary, type HomeBrief, type HomeBriefInput } from '@/lib/home/home-brief';
import { formatHomeBrief, homeBriefDisplaySchema, homeStepDisplaySchema } from '@/lib/home/home-brief-display';
import { HomeOutcomeCard } from '@/components/dashboard/home-outcome-card';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const now = new Date('2026-09-10T00:00:00Z');
const meal = { title: 'Mãe’s {count} <Tacos>', cuisine: 'Família & friends', effort: 'quick' as const, prepMinutes: 25, description: 'Our own {events} recipe' };
const input = (override: Partial<HomeBriefInput> = {}): HomeBriefInput => ({
  timezone: 'America/New_York', upcomingEvents: [], dinnerCandidates: [],
  choresPending: 0, openTodos: 0, groceryOpen: 0, memberCount: 1, ...override,
});
const event = (day: number, hour = 16) => ({ title: `School ${day}/${hour}`, start: `2026-09-${day}T${hour}:00:00Z`, end: `2026-09-${day}T${hour + 1}:00:00Z` });
const options = (locale: LocaleCode) => ({ locale, t: (key: string, params?: Record<string, string | number>) => translate(getMessages(locale), key, params) });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const legacyView = (brief: HomeBrief) => ({ headline: brief.headline, steps: brief.steps.map(({ label, detail }) => ({ label, detail })) });

describe('Home outcome display facts and canonical compatibility', () => {
  it('captures each computed branch without changing summary bytes or the canonical urgency claim', () => {
    const brief = buildHomeBrief(input({ openTodos: 1 }), now);
    const canonical = '{"headline":"You’re in good shape — 0 events this week and nothing urgent.","readinessPct":0,"isSparse":false,"weekCount":0,"conflictCount":0,"dinnerCount":0,"timeSavedMinutes":0,"steps":[{"id":"calendar","done":false},{"id":"meals","done":false},{"id":"family","done":false},{"id":"grocery","done":false},{"id":"chores","done":false}]}';
    expect(JSON.stringify(homeBriefSummary(brief))).toBe(canonical);
    expect(brief.display).toEqual({ version: 1, headline: 'clear' });
    expect(formatHomeBrief(brief, options('en-US')).headline).toBe('Your week at a glance — 0 events on the calendar.');
    expect(JSON.stringify(homeBriefSummary(brief))).toBe(canonical);
    expect(buildHomeBrief(input(), now).display?.headline).toBe('sparse');
    const busy = buildHomeBrief(input({ openTodos: 1, upcomingEvents: [event(10), event(10)] }), now);
    expect(busy.display?.headline).toBe('conflicts');
    expect(busy.conflictCount).toBe(1);
    expect(formatHomeBrief(busy, options('en-US')).headline).toBe('You’re rolling — 2 events ahead, 1 clash to smooth out.');
  });

  it.each(locales)('formats %s without changing raw meals, IDs, hrefs, order, done, counts or summaries', (locale) => {
    const source = input({ upcomingEvents: [event(10), event(10)], dinnerCandidates: [meal], memberCount: 3, choresPending: 2, groceryOpen: 1 });
    const beforeInput = structuredClone(source);
    const brief = freeze(buildHomeBrief(source, now));
    const before = JSON.stringify(brief), summary = JSON.stringify(homeBriefSummary(brief));
    const view = formatHomeBrief(brief, options(locale));
    expect(view.steps).toHaveLength(5);
    expect(view.steps[0].detail).toContain(meal.title);
    if (locale === 'en-US') expect(view.steps[0].detail).toBe(`Start with ${meal.title}.`);
    else expect(view.steps[0].detail).not.toContain('Start with');
    expect(brief.steps.map(step => [step.id, step.href, step.done])).toEqual([
      ['meals', '/dashboard/meals', false], ['calendar', '/dashboard/calendar', true],
      ['family', '/dashboard/family-access', true], ['grocery', '/dashboard/grocery', true], ['chores', '/dashboard/chores', true],
    ]);
    expect(brief.readinessPct).toBe(80);
    expect(JSON.stringify(brief)).toBe(before);
    expect(JSON.stringify(homeBriefSummary(brief))).toBe(summary);
    expect(source).toEqual(beforeInput);
  });

  it('keeps the already-resolved family timezone authoritative and independent of display language', () => {
    const brief = buildHomeBrief(input({ openTodos: 1, upcomingEvents: [
      { title: 'Practice', start: '2026-09-09T23:30:00Z', end: '2026-09-10T01:00:00Z' },
      { title: 'Appointment', start: '2026-09-10T00:15:00Z', end: '2026-09-10T01:30:00Z' },
    ] }), now);
    expect(brief.conflictCount).toBe(1);
    for (const locale of locales) {
      expect(formatHomeBrief(brief, options(locale)).headline).toContain(options(locale).t('homeOutcome.clashes.one', { count: 1 }));
    }
  });
});

describe('Home outcome count grammar and catalogue coverage', () => {
  it.each([
    ['en-US', '0 events', '1 event', '2 events'], ['de-DE', '0 Termine', '1 Termin', '2 Termine'],
    ['es-ES', '0 eventos', '1 evento', '2 eventos'], ['fr-FR', '0 événement', '1 événement', '2 événements'],
    ['it-IT', '0 eventi', '1 evento', '2 eventi'], ['nl-NL', '0 afspraken', '1 afspraak', '2 afspraken'],
    ['pt-PT', '0 eventos', '1 evento', '2 eventos'],
  ] as const)('%s uses its own zero, singular and plural forms', (locale, zero, one, two) => {
    for (const [count, words] of [zero, one, two].entries()) {
      const brief = buildHomeBrief(input({ openTodos: 1, upcomingEvents: Array.from({ length: count }, (_, i) => event(10 + i)) }), now);
      const view = formatHomeBrief(brief, options(locale));
      expect(view.headline).toContain(words);
      if (count > 0) expect(view.steps[brief.steps.findIndex(step => step.id === 'calendar')].detail).toContain(words);
    }
    const brief = buildHomeBrief(input({ openTodos: 1, upcomingEvents: [event(10), event(10), event(11), event(11)] }), now);
    expect(brief.conflictCount).toBe(2);
    expect(formatHomeBrief(brief, options(locale)).headline).toContain(options(locale).t('homeOutcome.clashes.other', { count: 2 }));
  });

  it('formats large counts with the requested locale while leaving the underlying value alone', () => {
    const brief = buildHomeBrief(input({ openTodos: 1 }), now);
    brief.weekCount = 1234;
    const calendar = brief.steps.find(step => step.id === 'calendar')!;
    calendar.done = true;
    calendar.display = { version: 1, kind: 'calendar', eventCount: 1234 };
    expect(formatHomeBrief(brief, options('de-DE')).headline).toContain('1.234 Termine');
    expect(formatHomeBrief(brief, options('fr-FR')).headline).toContain('1 234 événements');
    expect(brief.weekCount).toBe(1234);
  });

  it.each(locales)('%s resolves every generated label and placeholder from its actual catalogue', (locale) => {
    const raw = getRawMessages(locale), seen = new Set<string>();
    const t = (key: string, params?: Record<string, string | number>) => {
      expect(raw[key], key).toBeTruthy();
      expect(Object.keys(params ?? {}).sort()).toEqual((raw[key].match(/\{(\w+)\}/g) ?? []).map(token => token.slice(1, -1)).sort());
      seen.add(key);
      return translate(raw, key, params);
    };
    for (const source of [input(), input({ openTodos: 1 }), input({ openTodos: 1, upcomingEvents: [event(10)] }), input({ upcomingEvents: [event(10), event(10)], dinnerCandidates: [meal], memberCount: 2, groceryOpen: 1, choresPending: 1 })]) {
      const brief = buildHomeBrief(source, now);
      formatHomeBrief(brief, { locale, t });
      renderToStaticMarkup(createElement(HomeOutcomeCard, { homeBrief: brief, locale, t }));
    }
    expect(seen).toContain('homeOutcome.familyDone');
    expect(seen).toContain('homeOutcome.choresEmpty');
    expect(seen).toContain('onboardingCopy.inviteYourFamily');
  });
});

describe('Home outcome per-item legacy fallback', () => {
  it('does not infer metadata from canonical English and leaves a legacy brief byte-identical', () => {
    const brief = buildHomeBrief(input({ dinnerCandidates: [meal] }), now);
    delete brief.display;
    brief.steps.forEach(step => { delete step.display; });
    const before = JSON.stringify(brief);
    expect(formatHomeBrief(freeze(brief), options('de-DE'))).toEqual(legacyView(brief));
    expect(JSON.stringify(brief)).toBe(before);
  });

  it.each([null, {}, { version: 2, headline: 'sparse' }, { version: 1, headline: 'unknown' }, { version: 1, headline: 'sparse', extra: true }, { version: 1, headline: 'clear' }])('falls back for only an invalid or inconsistent headline: %j', (display) => {
    const brief = buildHomeBrief(input(), now);
    Object.assign(brief, { display });
    const view = formatHomeBrief(brief, options('de-DE'));
    expect(view.headline).toBe(brief.headline);
    expect(view.steps[0].label).toBe('Tragen Sie Ihre Woche ein');
  });

  it.each([
    undefined, { version: 2, kind: 'calendar', eventCount: 0 }, { version: 1, kind: 'calendar', eventCount: -1 },
    { version: 1, kind: 'calendar', eventCount: 1.5 }, { version: 1, kind: 'calendar', eventCount: '0' },
    { version: 1, kind: 'calendar', eventCount: Infinity }, { version: 1, kind: 'calendar', eventCount: 1 },
    { version: 1, kind: 'calendar', eventCount: 0, extra: true }, { version: 1, kind: 'family' },
  ])('falls back for only an invalid or mismatched step: %j', (display) => {
    const brief = buildHomeBrief(input(), now);
    Object.assign(brief.steps[0], { display });
    const view = formatHomeBrief(brief, options('de-DE'));
    expect(view.steps[0]).toEqual(legacyView(brief).steps[0]);
    expect(view.steps[1].label).toBe('Planen Sie die Abendessen dieser Woche');
    expect(view.headline).not.toBe(brief.headline);
  });

  it('rejects stale meal titles and calendar done state without replacing raw details', () => {
    const brief = buildHomeBrief(input({ dinnerCandidates: [meal] }), now);
    brief.steps[0].done = true;
    brief.steps[1].display = { version: 1, kind: 'meals', dinnerTitle: 'Someone else’s recipe' };
    const view = formatHomeBrief(brief, options('pt-PT'));
    expect(view.steps.slice(0, 2)).toEqual(legacyView(brief).steps.slice(0, 2));
    expect(view.steps[2].label).not.toBe(brief.steps[2].label);
  });

  it('roundtrips fresh semantic facts through strict schemas', () => {
    const brief = buildHomeBrief(input(), now);
    expect(homeBriefDisplaySchema.parse(JSON.parse(JSON.stringify(brief.display)))).toEqual(brief.display);
    for (const step of brief.steps) expect(homeStepDisplaySchema.parse(JSON.parse(JSON.stringify(step.display)))).toEqual(step.display);
  });
});

describe('actual Home outcome renderer', () => {
  it.each(locales)('%s renders four ordered actions, original links/dinners, readiness and the neutral headline', (locale) => {
    const brief = freeze(buildHomeBrief(input({ dinnerCandidates: [meal], memberCount: 3, groceryOpen: 1, choresPending: 1 }), now));
    const opts = options(locale);
    const html = renderToStaticMarkup(createElement(HomeOutcomeCard, { homeBrief: brief, ...opts }));
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs).toEqual([...brief.steps.slice(0, 4).map(step => step.href), '/dashboard/meals']);
    expect(html).toContain('width:60%');
    expect(html).toContain(new Intl.NumberFormat(locale, { style: 'percent' }).format(0.6));
    expect(html).toContain(opts.t('homeOutcome.ready'));
    expect(html).toContain('Mãe’s {count} &lt;Tacos&gt;');
    expect(html).toContain('Família &amp; friends');
    expect(html).not.toContain('<Tacos>');
    expect(html).not.toContain('nothing urgent');
    expect(html).not.toContain('homeOutcome.');
    expect(html).not.toContain('Our own {events} recipe');
    expect(html.match(/line-through/g)).toHaveLength(2);
  });

  it('renders the sparse title without a dinner section or time estimate when none exist', () => {
    const brief = buildHomeBrief(input(), now);
    const html = renderToStaticMarkup(createElement(HomeOutcomeCard, { homeBrief: brief, ...options('en-US') }));
    expect(html).toContain('Your first wins');
    expect(html.match(/href=/g)).toHaveLength(4);
    expect(html).not.toContain('Dinner ideas');
    expect(html).not.toContain('Estimated planning time');
  });
});
