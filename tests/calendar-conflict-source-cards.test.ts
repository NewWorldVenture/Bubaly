import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CalendarConflictCardView } from '@/components/ai/cards/calendar-conflict';
import { cardFromToolResult, parseAssistantStreamEvent, parseResultCard, structuredContentFrom, toStructuredContent,
  type CalendarConflictCard, type CalendarConflictSubject } from '@/lib/ai/result-cards';
import { cardSections, parseAssistantResponse, parseCards } from '@/mobile/src/lib/assistant-core';

const locale = vi.hoisted(() => ({ value: 'en-US' }));
import en from '@/lib/i18n/messages/en-US.json';
import de from '@/lib/i18n/messages/de-DE.json';
import { translate } from '@/lib/i18n/translate';
import { mobileTranslate } from '@/mobile/src/lib/mobile-i18n';
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(locale.value === 'de-DE' ? de : en, key, params) }));
vi.mock('@/components/ai/cards/index', () => ({
  CardFrame: ({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) => createElement('section', null, title, subtitle, children),
  MoreRow: () => null,
}));
const id = '11111111-1111-4111-8111-111111111111';
const source = (): CalendarConflictSubject => ({ kind: 'source', title: 'Imported school', occurrenceKey: 'source:original-clock',
  reference: { kind: 'source', feedId: '22222222-2222-4222-8222-222222222222', uid: 'escaped\\,uid' + 'x'.repeat(4084),
    revisionId: '33333333-3333-4333-8333-333333333333', original: { kind: 'zoned', value: '20261101T013000', tzid: 'America/New_York' } },
  readOnly: true, mutable: false, actualStartsAt: '2026-11-01T05:30:00Z', actualEndsAt: '2026-11-01T07:00:00Z' });
const native = (readOnly = false): CalendarConflictSubject => ({ kind: 'native', title: 'Native dentist', occurrenceKey: 'native:occurrence',
  reference: { kind: 'native', eventId: id }, eventId: id, readOnly, mutable: !readOnly,
  actualStartsAt: '2026-11-01T05:45:00Z', actualEndsAt: null });
function card(subjects: CalendarConflictSubject[] = [source(), native()]): CalendarConflictCard {
  const value = cardFromToolResult('calendar.findConflicts', {}, { ok: true, summary: 'Family occupancy advisory', data: {
    conflicts: [], advisories: [{ kind: 'family-source-overlap', scope: 'family', subjects,
      startsAt: '2026-11-01T05:45:00Z', endsAt: '2026-11-01T06:45:00Z', when: 'Sunday' }],
  } });
  expect(value?.kind).toBe('calendar_conflict');
  return value as CalendarConflictCard;
}
function buttons(value: ReactNode): ReactElement<{ onClick: () => void }>[] {
  if (Array.isArray(value)) return value.flatMap(buttons);
  if (!isValidElement(value)) return [];
  const element = value as ReactElement<{ children?: ReactNode; onClick: () => void }>;
  return [...(element.type === 'button' ? [element] : []), ...buttons(element.props.children)];
}
function render(value: CalendarConflictCard) { return renderToStaticMarkup(createElement(CalendarConflictCardView, { card: value, onAsk: vi.fn() })); }

describe('qualified source conflict cards', () => {
  it('preserves full original provenance through mapper, schema, JSON, SSE, storage and mobile parsing', () => {
    const value = card();
    expect(value.advisories?.[0].subjects[0]).toEqual(source());
    expect(parseResultCard(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseAssistantStreamEvent({ type: 'card', card: value })).toEqual({ type: 'card', card: value });
    expect(structuredContentFrom(JSON.parse(JSON.stringify(toStructuredContent([value], [])))).cards).toEqual([value]);
    expect(parseCards([value])).toEqual([value]);
    const reply = parseAssistantResponse(200, { content: 'Advisory', cards: [value] });
    expect(reply.ok && reply.reply.cards).toEqual([value]);
  });
  it.each([false, true])('chooses a mutable genuine native target with source first=%s', reverse => {
    const value = card(reverse ? [native(), source()] : [source(), native()]);
    const html = render(value);
    expect(html).toContain('Move Native dentist');
    expect(html).not.toContain('Move Imported school');
    expect(html).toContain('0 personal overlaps');
    expect(html).toContain('1 family advisory');
    expect(html).toContain('does not identify who is double-booked');
    const ask = vi.fn();
    const found = buttons(CalendarConflictCardView({ card: value, onAsk: ask }));
    expect(found).toHaveLength(1);
    found[0].props.onClick();
    expect(ask).toHaveBeenCalledWith(expect.stringContaining(id));
    expect(ask.mock.calls[0][0]).toContain('native:occurrence');
    expect(ask.mock.calls[0][0]).not.toContain('Imported school');
  });
  it('source-only and imported legacy native subjects cannot offer Move', () => {
    const other = { ...source(), occurrenceKey: 'source:second' };
    expect(render(card([source(), other]))).not.toContain('Move ');
    expect(render(card([source(), native(true)]))).not.toContain('Move ');
  });
  it('mobile actual sections render source-only and mixed advisories as warnings, retaining their family scope', () => {
    for (const subjects of [[source(), { ...source(), occurrenceKey: 'source:second' }], [source(), native()]]) {
      const value = card(subjects);
      const section = cardSections(value);
      expect(section.tone).toBe('warning');
      expect(section.subtitle).toContain('1 family advisory');
      expect(JSON.stringify(section)).toContain('Family occupancy advisory');
      expect(JSON.stringify(section)).toContain('Imported school');
      expect(JSON.stringify(section)).not.toContain('Nobody');
    }
  });
  it('localizes family scope and action prose while preserving the exact native ID and occurrence key', () => {
    locale.value = 'de-DE';
    try {
      const value = card();
      expect(render(value)).toContain('Hinweis zur Familienbelegung');
      expect(render(value)).toContain('Native dentist verschieben');
      expect(render(value)).not.toContain('Move Native dentist');
      const ask = vi.fn();
      buttons(CalendarConflictCardView({ card: value, onAsk: ask }))[0].props.onClick();
      expect(ask.mock.calls[0][0]).toContain('Verschiebe');
      expect(ask.mock.calls[0][0]).toContain(id);
      expect(ask.mock.calls[0][0]).toContain('native:occurrence');
      const section = cardSections(value, (key, params) => mobileTranslate('de-DE', key, params));
      expect(section.tone).toBe('warning');
      expect(section.subtitle).toContain('1 Familienhinweis');
      expect(section.lines.join(' ')).toContain('Hinweis zur Familienbelegung');
      const legacy = { kind: 'calendar_conflict', title: 'Legacy', conflicts: [{ when: 'Sunday', titles: ['Dentist', 'Soccer'], member: 'Sam', event_ids: [id, id] }] };
      expect(cardSections(legacy).lines).toEqual(['Dentist and Soccer overlap Sunday · Sam']);
    } finally { locale.value = 'en-US'; }
  });
  it('compact cards never offer mutation controls', () => {
    expect(buttons(CalendarConflictCardView({ card: card(), compact: true, onAsk: vi.fn() }))).toHaveLength(0);
  });
  it('legacy stored rows stay informational without assuming native provenance', () => {
    const legacy = parseResultCard({ kind: 'calendar_conflict', title: 'Legacy', conflicts: [
      { titles: ['Imported title', 'Native title'], when: 'Sunday', member: 'Sam', event_ids: [id, id] },
    ] }) as CalendarConflictCard;
    expect(legacy).not.toBeNull();
    expect(render(legacy)).not.toContain('Move ');
  });
  it('modern personal rows keep real IDs distinct from two recurring occurrence identities', () => {
    const one = native(), two = { ...native(), occurrenceKey: 'native:second' };
    const value = cardFromToolResult('calendar.findConflicts', {}, { ok: true, data: { advisories: [], conflicts: [
      { kind: 'personal', when: 'Sunday', member_id: 'm', titles: ['Native dentist', 'Native dentist'], event_ids: [id, id],
        subjects: [one, two], occurrenceKeys: [one.occurrenceKey, two.occurrenceKey], references: [one.reference, two.reference] },
    ] } }, { members: { m: 'Sam' } }) as CalendarConflictCard;
    expect(value.conflicts[0].event_ids).toEqual([id, id]);
    expect(render(value)).toContain('1 personal overlap');
    expect(render(value)).toContain('Sam');
    expect(render(value)).toContain('Move Native dentist');
  });
  it.each(['readOnly', 'mutable', 'reference', 'occurrenceKey', 'kind'])('refuses missing source qualifier %s before producing a calm card', key => {
    const value = JSON.parse(JSON.stringify(card()));
    delete value.advisories[0].subjects[0][key];
    expect(parseResultCard(value)).toBeNull();
    expect(cardFromToolResult('calendar.findConflicts', {}, { ok: true, data: { conflicts: [], advisories: value.advisories } })).toBeNull();
  });
  it.each([
    { readOnly: false }, { mutable: true }, { kind: 'unknown' }, { eventId: id },
    { reference: { ...source().reference, uid: 'x'.repeat(4097) } },
    { reference: { ...source().reference, uid: 'bad\u0000uid' } },
    { reference: { ...source().reference, uid: 'bad\ud800uid' } },
    { reference: { ...source().reference, original: { kind: 'utc', value: '20261101T013060Z' } } },
    { reference: { ...source().reference, original: { kind: 'date', value: '20260230' } } },
  ])('refuses unsafe source metadata %j', patch => {
    const value = JSON.parse(JSON.stringify(card()));
    Object.assign(value.advisories[0].subjects[0], patch);
    expect(parseResultCard(value)).toBeNull();
  });
  it('refuses an advisory outside either subject occupied span, including the native one-hour estimate', () => {
    for (const patch of [{ startsAt: '2026-11-01T04:45:00Z' }, { endsAt: '2026-11-01T07:01:00Z' },
      { startsAt: '2026-11-01T17:00:00Z', endsAt: '2026-11-01T18:00:00Z' }]) {
      const value = JSON.parse(JSON.stringify(card()));
      Object.assign(value.advisories[0], patch);
      expect(parseResultCard(value)).toBeNull();
    }
    const clipped = JSON.parse(JSON.stringify(card()));
    clipped.advisories[0].startsAt = '2026-11-01T06:00:00Z';
    clipped.advisories[0].endsAt = '2026-11-01T06:30:00Z';
    expect(parseResultCard(clipped)).toEqual(clipped);
  });
  it('refuses malformed conflict arrays and failed reads without a calm card', () => {
    for (const data of [{}, { conflicts: null }, { conflicts: [null] }, { conflicts: [], advisories: null }]) {
      expect(cardFromToolResult('calendar.findConflicts', {}, { ok: true, data })).toBeNull();
    }
    expect(cardFromToolResult('calendar.findConflicts', {}, { ok: false, data: { conflicts: [], advisories: [] } })).toBeNull();
  });
  it('distinguishes fully qualified clear wording from historical personal-only compatibility', () => {
    const value = cardFromToolResult('calendar.findConflicts', {}, { ok: true, data: { conflicts: [], advisories: [] } }) as CalendarConflictCard;
    expect(render(value)).toContain('No personal double-bookings or family source occupancy overlaps found.');
  });
});
