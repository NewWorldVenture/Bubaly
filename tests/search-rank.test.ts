// Ranking is the whole product difference between "a search box" and "the
// household knows where things are". These pin the three signals separately —
// how it matched, what kind it is, how near in time — plus the two properties
// that keep the list trustworthy: nothing the database matched is silently
// dropped, and equal results never reorder between renders.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  groupByKind, kindLabelKey, MATCHED_FLOOR, rankHits, recencyBoost, scoreHit,
  SEARCH_KINDS, SEARCH_KIND_META, textMatchScore, type SearchHit,
} from '@/lib/search/rank';

const NOW = new Date('2026-07-04T12:00:00Z');

function hit(over: Partial<Omit<SearchHit, 'score'>> = {}): Omit<SearchHit, 'score'> {
  return {
    kind: 'note',
    id: 'n-1',
    title: 'Furnace warranty',
    snippet: null,
    table: 'notes',
    occurredAt: null,
    href: '/dashboard/notes',
    ...over,
  };
}

describe('textMatchScore', () => {
  it('ranks exact > prefix > word-prefix > substring > all-terms', () => {
    expect(textMatchScore('furnace warranty', 'Furnace warranty')).toBe(100);
    expect(textMatchScore('furnace', 'Furnace warranty — Carrier')).toBe(80);
    expect(textMatchScore('warranty', 'Furnace warranty')).toBe(60);
    expect(textMatchScore('arrant', 'Furnace warranty')).toBe(40);
    // Every word present, wrong order — the weakest tier, still above nothing.
    expect(textMatchScore('warranty furnace', 'Furnace warranty — Carrier')).toBe(30);
    expect(textMatchScore('boiler', 'Furnace warranty')).toBe(0);
  });

  it('is 0 for an empty query or empty text, so a blank never matches everything', () => {
    expect(textMatchScore('', 'Furnace warranty')).toBe(0);
    expect(textMatchScore('furnace', null)).toBe(0);
    expect(textMatchScore('furnace', '   ')).toBe(0);
  });
});

describe('recencyBoost', () => {
  it('treats near-future and near-past alike — "recent" for a household means "near now"', () => {
    const inThreeDays = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    expect(recencyBoost(inThreeDays, NOW)).toBe(recencyBoost(threeDaysAgo, NOW));
    expect(recencyBoost(threeDaysAgo, NOW)).toBe(12);
  });

  it('decays by band and gives an undated or unparseable record nothing rather than a penalty', () => {
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    expect(recencyBoost(daysAgo(20), NOW)).toBe(8);
    expect(recencyBoost(daysAgo(100), NOW)).toBe(4);
    expect(recencyBoost(daysAgo(300), NOW)).toBe(2);
    expect(recencyBoost(daysAgo(900), NOW)).toBe(0);
    expect(recencyBoost(null, NOW)).toBe(0);
    expect(recencyBoost('not a date', NOW)).toBe(0);
  });
});

describe('scoreHit', () => {
  it('weights a title match above the same text in the body', () => {
    const inTitle = scoreHit('furnace', hit({ title: 'Furnace warranty', snippet: null }), NOW);
    const inBody = scoreHit('furnace', hit({ title: 'Boiler paperwork', snippet: 'Furnace warranty scan' }), NOW);
    expect(inTitle).toBeGreaterThan(inBody);
  });

  it('keeps a row the database matched on a column the card does not show', () => {
    // The service matched `serial_number`; neither the title nor the snippet
    // contains the query. Dropping it would hide a real answer.
    const bySerial = scoreHit('X72-9911', hit({ kind: 'item', title: 'Lawn mower', snippet: 'Honda', occurredAt: null }), NOW);
    expect(bySerial).toBeGreaterThanOrEqual(MATCHED_FLOOR);
  });

  it('lets kind weight and recency break a tie between two identical matches', () => {
    const bill = scoreHit('electric', hit({ kind: 'bill', title: 'Electric', table: 'bills' }), NOW);
    const note = scoreHit('electric', hit({ kind: 'note', title: 'Electric' }), NOW);
    expect(bill).toBeGreaterThan(note);

    const recent = scoreHit('electric', hit({ title: 'Electric', occurredAt: NOW.toISOString() }), NOW);
    const stale = scoreHit('electric', hit({ title: 'Electric', occurredAt: '2019-01-01T00:00:00Z' }), NOW);
    expect(recent).toBeGreaterThan(stale);
  });
});

describe('rankHits', () => {
  const hits = [
    hit({ id: 'a', kind: 'note', title: 'Boiler notes', snippet: 'furnace warranty is in the binder' }),
    hit({ id: 'b', kind: 'warranty', table: 'home_warranties', href: '/dashboard/home/warranties', title: 'Furnace warranty', occurredAt: '2026-07-01T00:00:00Z' }),
    hit({ id: 'c', kind: 'document', table: 'documents', title: 'Warranty — furnace, 2019', occurredAt: '2019-05-01T00:00:00Z' }),
  ];

  it('puts the record actually called that first, and the passing mention last', () => {
    const ranked = rankHits('furnace warranty', hits, { now: NOW });
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(ranked[0].score).toBeGreaterThan(ranked[2].score);
  });

  it('is deterministic for equal hits and honours the limit', () => {
    const tied = [
      hit({ id: 'z', title: 'Same', occurredAt: null }),
      hit({ id: 'a', title: 'Same', occurredAt: null }),
    ];
    expect(rankHits('same', tied, { now: NOW }).map((r) => r.id)).toEqual(['a', 'z']);
    expect(rankHits('same', [...tied].reverse(), { now: NOW }).map((r) => r.id)).toEqual(['a', 'z']);
    expect(rankHits('same', tied, { now: NOW, limit: 1 })).toHaveLength(1);
  });

  it('carries the evidence through untouched — table, date and link are what makes a hit checkable', () => {
    const [first] = rankHits('furnace warranty', hits, { now: NOW });
    expect(first).toMatchObject({ table: 'home_warranties', occurredAt: '2026-07-01T00:00:00Z', href: '/dashboard/home/warranties' });
  });
});

describe('groupByKind', () => {
  it('orders groups by the catalogue and omits kinds with nothing in them', () => {
    const ranked = rankHits('x', [
      hit({ id: '1', kind: 'note' }),
      hit({ id: '2', kind: 'bill' }),
      hit({ id: '3', kind: 'document' }),
      hit({ id: '4', kind: 'bill' }),
    ], { now: NOW });
    const groups = groupByKind(ranked);
    expect(groups.map((g) => g.kind)).toEqual(['bill', 'document', 'note']);
    expect(groups[0].hits).toHaveLength(2);
    expect(groups.some((g) => g.kind === 'trip')).toBe(false);
  });
});

describe('kind metadata', () => {
  const messages = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

  it('describes every kind exactly once', () => {
    expect(SEARCH_KIND_META.map((m) => m.kind).sort()).toEqual([...SEARCH_KINDS].sort());
    expect(new Set(SEARCH_KIND_META.map((m) => m.kind)).size).toBe(SEARCH_KINDS.length);
  });

  it('gives every kind a catalogue key that exists, so no group heading renders a raw key', () => {
    for (const kind of SEARCH_KINDS) {
      expect(messages[kindLabelKey(kind)], kind).toBeTypeOf('string');
    }
  });
});
