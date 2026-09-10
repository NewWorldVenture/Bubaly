import { describe, expect, it } from 'vitest';
import { buildConciergeDigest, digestToPromptLines, type ConciergeDigest, type ConciergeSnapshot } from '@/lib/concierge/digest';
import { formatConciergeDigest } from '@/lib/concierge/digest-display';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const locales: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const snapshot: ConciergeSnapshot = {
  now: '2026-09-09T16:00:00.000Z',
  bills: [{ name: 'Bill {amount} <raw>', amount: 12.5, dueDate: '2026-09-08' }, { name: 'No amount', dueDate: '2026-09-09' }],
  medications: [{ name: 'Medicine {raw}', member: 'Sam {raw}', timeOfDay: '08:30' }, { name: 'Unassigned medicine' }],
  maintenance: [{ title: 'Filter {raw}', dueAt: '2026-09-11' }],
  warranties: [{ name: 'Washer warranty {raw}', expiresOn: '2026-09-07' }],
  trips: [{ title: 'Current trip', startDate: '2026-09-08', endDate: '2026-09-10', destination: 'Porto {raw}' }, { title: 'Next trip', startDate: '2026-09-12', destination: 'Roma <raw>' }],
  pantry: [{ name: 'Milk', expiresAt: '2026-09-10' }, { name: 'Expired food', expiresAt: '2026-09-06' }],
};
const view = (digest: ConciergeDigest, locale: LocaleCode) => formatConciergeDigest(digest, locale, (key, params) => translate(getMessages(locale), key, params));
const withoutFacts = (digest: ConciergeDigest) => ({ ...digest, items: digest.items.map(({ display: _display, ...item }) => item) });

describe('request-only concierge digest display', () => {
  it.each(locales)('%s preserves canonical items/order/counts/grounding and raw values', locale => {
    const digest = buildConciergeDigest(snapshot), before = JSON.stringify(digest), grounding = digestToPromptLines(digest);
    const result = view(digest, locale);
    expect(JSON.stringify(digest)).toBe(before); expect(digestToPromptLines(digest)).toBe(grounding);
    expect(result.counts).toEqual(digest.counts); expect(result.byDomain).toEqual(digest.byDomain);
    expect(result.items.map(item => [item.domain, item.urgency, item.dayOffset, item.member])).toEqual(digest.items.map(item => [item.domain, item.urgency, item.dayOffset, item.member]));
    expect(result.items.every(item => !('display' in item))).toBe(true);
    expect(result.items.find(item => item.domain === 'bill' && item.dayOffset === -1)?.title).toBe('Bill {amount} <raw>');
    expect(result.items.find(item => item.domain === 'bill' && item.dayOffset === -1)?.detail).toContain(new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(12.5));
    expect(result.items.find(item => item.domain === 'medication' && item.title === 'Medicine {raw}')?.detail).toBe('Sam {raw} · 08:30');
    expect(result.items.find(item => item.domain === 'warranty')?.title).toContain('Washer warranty {raw}');
    expect(result.items.find(item => item.domain === 'trip' && item.dayOffset === 0)?.detail).toContain('Porto {raw}');
    expect(result.items.find(item => item.domain === 'trip' && item.dayOffset === 3)?.detail).toContain('Roma <raw>');
    for (const item of result.items.filter(item => !(item.domain === 'trip' && item.dayOffset === 0))) expect(item.dueLabel).toBe(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(item.dayOffset, 'day'));
    expect(JSON.stringify(result)).not.toMatch(/conciergeDisplay\./);
  });

  it.each([undefined, { version: 99 }, { version: 1, kind: 'unknown', name: 'Wrong', dayOffset: -1 },
    { version: 1, kind: 'bill', name: 'Wrong', amount: 12.5, dayOffset: -1 },
    { version: 1, kind: 'bill', name: 'Bill {amount} <raw>', amount: Infinity, dayOffset: -1 },
    { version: 1, kind: 'bill', name: 'Bill {amount} <raw>', amount: 12.5, dayOffset: 0 },
    { version: 1, kind: 'bill', name: 'Bill {amount} <raw>', amount: 12.5, dayOffset: -1, extra: true },
  ])('missing/malformed/inconsistent item metadata falls back locally: %j', facts => {
    const digest = buildConciergeDigest(snapshot), index = digest.items.findIndex(item => item.domain === 'bill' && item.dayOffset === -1);
    Object.assign(digest.items[index], { display: facts }); const before = structuredClone(digest);
    const result = view(digest, 'de-DE');
    expect(result.items[index]).toEqual(withoutFacts(digest).items[index]);
    expect(result.items.find(item => item.domain === 'warranty')?.title).toBe('Garantie für Washer warranty {raw}');
    expect(digest).toEqual(before);
  });

  it('legacy items with no facts are kept verbatim, including text that resembles a generated label', () => {
    const digest = withoutFacts(buildConciergeDigest(snapshot)), before = structuredClone(digest);
    expect(view(digest, 'fr-FR').items).toEqual(digest.items); expect(digest).toEqual(before);
  });

  it.each(['warranty', 'medication'] as const)('keeps legacy %s content when redundant raw facts disagree', domain => {
    const digest = buildConciergeDigest(snapshot), index = digest.items.findIndex(item => item.domain === domain);
    const item = digest.items[index];
    if (item.display?.kind === 'warranty') item.display.name = 'Different private item';
    if (item.display?.kind === 'medication') item.display.member = 'Different member';
    const before = structuredClone(digest), result = view(digest, 'de-DE');
    expect(result.items[index]).toEqual(withoutFacts(digest).items[index]);
    expect(result.items.find(entry => entry.domain === 'maintenance')?.detail).toBe('Fällig übermorgen');
    expect(digest).toEqual(before);
  });

  it.each(['amount', 'destination', 'time', 'phase'] as const)('keeps the affected item when stale %s facts contradict canonical text', field => {
    const digest = buildConciergeDigest(snapshot);
    const index = digest.items.findIndex(item => field === 'amount' ? item.domain === 'bill' && item.dayOffset === -1
      : field === 'time' ? item.domain === 'medication' && !!item.member : item.domain === 'trip' && item.dayOffset === 0);
    const facts = digest.items[index].display!;
    if (facts.kind === 'bill') facts.amount = 950;
    if (facts.kind === 'medication') facts.timeOfDay = '20:30';
    if (facts.kind === 'trip' && field === 'destination') facts.destination = 'Rome';
    if (facts.kind === 'trip' && field === 'phase') facts.phase = 'departure';
    const before = structuredClone(digest), result = view(digest, 'fr-FR');
    expect(result.items[index]).toEqual(withoutFacts(digest).items[index]);
    expect(result.items.find(item => item.domain === 'warranty')?.title).toBe('Garantie de Washer warranty {raw}');
    expect(digest).toEqual(before);
  });

  it('does not localize inconsistent urgency or ongoing-trip day metadata', () => {
    const digest = buildConciergeDigest(snapshot);
    digest.items[0].urgency = 'soon';
    const trip = digest.items.find(item => item.domain === 'trip' && item.dayOffset === 0)!;
    trip.dayOffset = 2; if (trip.display) trip.display.dayOffset = 2;
    const result = view(digest, 'pt-PT');
    expect(result.items[0]).toEqual(withoutFacts(digest).items[0]);
    expect(result.items.find(item => item.title === trip.title)).toEqual(withoutFacts(digest).items.find(item => item.title === trip.title));
  });

  it.each(locales)('%s translates empty state without changing the empty canonical digest', locale => {
    const digest = buildConciergeDigest({ now: snapshot.now });
    expect(view(digest, locale)).toEqual({ ...digest, headline: translate(getMessages(locale), 'conciergeDisplay.empty') });
    expect(digest.headline).toBe("You're all caught up — nothing needs attention right now.");
  });
});
