import { describe, it, expect } from 'vitest';
import {
  MAX_RECORD_RESULTS, MAX_RESULTS, MIN_RECORD_QUERY, navMatchScore, routeCommand, searchHref,
  type CommandNavItem, type CommandRecord,
} from '@/lib/command-bar/route';
import { NAV_CATALOG } from '@/lib/constants/navigation';

const now = new Date('2026-07-04T10:00:00');
const NAV: CommandNavItem[] = [
  { href: '/wallet', label: 'Wallet' },
  { href: '/dashboard/billing', label: 'Billing' },
  { href: '/dashboard/calendar', label: 'Calendar' },
  { href: '/dashboard/chores', label: 'Chores' },
  { href: '/dashboard/messages', label: 'Messages' },
];

describe('navMatchScore', () => {
  it('ranks exact > prefix > word-prefix > substring > subsequence', () => {
    expect(navMatchScore('wallet', 'Wallet')).toBe(100);
    expect(navMatchScore('wall', 'Wallet')).toBe(80);
    expect(navMatchScore('cal', 'Family Calendar')).toBe(60);
    expect(navMatchScore('ess', 'Messages')).toBe(40);
    expect(navMatchScore('msg', 'Messages')).toBe(20); // m..s..g subsequence
    expect(navMatchScore('xyz', 'Wallet')).toBe(0);
  });
});

describe('routeCommand', () => {
  it('returns [] for a blank query', () => {
    expect(routeCommand('   ', NAV, now)).toEqual([]);
  });

  it('leads with a strong nav match, and always ends with the assistant fallback', () => {
    const r = routeCommand('wallet', NAV, now);
    expect(r[0]).toMatchObject({ kind: 'navigate', href: '/wallet' });
    expect(r[r.length - 1].kind).toBe('assistant');
  });

  it('puts an EXPLICIT capture intent above weak nav matches', () => {
    const r = routeCommand('remind me to call the dentist', NAV, now);
    const capIdx = r.findIndex((x) => x.kind === 'capture');
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(r[capIdx]).toMatchObject({ kind: 'capture', captureKind: 'task', explicit: true });
    // no strong nav match here, so capture should be first
    expect(capIdx).toBe(0);
  });

  it('routes an explicit shopping command to a shopping capture', () => {
    const r = routeCommand('add milk to the shopping list', NAV, now);
    expect(r.some((x) => x.kind === 'capture' && x.captureKind === 'shopping')).toBe(true);
  });

  it('offers a heuristic capture for multi-word non-commands, below nav', () => {
    const r = routeCommand('billing looks wrong', NAV, now);
    const navIdx = r.findIndex((x) => x.kind === 'navigate' && x.href === '/dashboard/billing');
    const capIdx = r.findIndex((x) => x.kind === 'capture');
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeGreaterThan(navIdx); // capture sits below the nav match
    expect(r[capIdx]).toMatchObject({ explicit: false });
  });

  it('does NOT add a heuristic capture for a single bare word (nav-only + assistant)', () => {
    const r = routeCommand('chores', NAV, now);
    // explicit? no. single word → no heuristic capture.
    expect(r.some((x) => x.kind === 'capture')).toBe(false);
    expect(r[0]).toMatchObject({ kind: 'navigate', href: '/dashboard/chores' });
    expect(r.at(-1)?.kind).toBe('assistant');
  });

  it('de-dupes repeated nav hrefs and caps the list', () => {
    const dupNav = [...NAV, { href: '/wallet', label: 'Wallet' }];
    const r = routeCommand('wallet', dupNav, now);
    expect(r.filter((x) => x.kind === 'navigate' && x.href === '/wallet')).toHaveLength(1);
    expect(r.length).toBeLessThanOrEqual(8);
  });
});

// ── Household records (M33) ─────────────────────────────────────────────────
// The bar used to match nav labels and nothing else: typing "furnace warranty"
// offered to ask the assistant about it rather than showing the warranty. These
// pin where the record block sits, that it cannot crowd out the fallback, and
// that the kinds that were already there keep their order.

const RECORDS: CommandRecord[] = [
  { kind: 'warranty', id: 'war-1', title: 'Furnace warranty', href: '/dashboard/home/warranties', occurredAt: '2027-03-01', score: 110 },
  { kind: 'document', id: 'doc-1', title: 'Furnace warranty scan', href: '/dashboard/documents', occurredAt: '2026-06-30', score: 98 },
  { kind: 'note', id: 'note-1', title: 'Basement', href: '/dashboard/notes', occurredAt: null, score: 17 },
];

describe('routeCommand — household records', () => {
  it('offers a record with its kind, date and an existing route', () => {
    const r = routeCommand('furnace warranty', NAV, now, RECORDS);
    const record = r.find((x) => x.kind === 'record');
    expect(record).toMatchObject({
      kind: 'record', recordKind: 'warranty', id: 'war-1',
      href: '/dashboard/home/warranties', label: 'Furnace warranty', occurredAt: '2027-03-01',
    });
  });

  it('sits below an exact nav match and above the assistant fallback', () => {
    const r = routeCommand('wallet', NAV, now, RECORDS);
    const navIdx = r.findIndex((x) => x.kind === 'navigate' && x.href === '/wallet');
    const recordIdx = r.findIndex((x) => x.kind === 'record');
    expect(navIdx).toBe(0);
    expect(recordIdx).toBeGreaterThan(navIdx);
    expect(r.at(-1)?.kind).toBe('assistant');
  });

  it('sits below an explicit capture command — "remind me to…" is still an instruction', () => {
    const r = routeCommand('remind me to call the furnace people', NAV, now, RECORDS);
    const capIdx = r.findIndex((x) => x.kind === 'capture');
    const recordIdx = r.findIndex((x) => x.kind === 'record');
    expect(capIdx).toBe(0);
    expect(recordIdx).toBeGreaterThan(capIdx);
  });

  it('shows at most MAX_RECORD_RESULTS of them, and never at the fallback’s expense', () => {
    const many: CommandRecord[] = Array.from({ length: 9 }, (_, i) => ({
      kind: 'note', id: `n-${i}`, title: `Note ${i}`, href: '/dashboard/notes', occurredAt: null, score: 50 - i,
    }));
    const r = routeCommand('furnace warranty', NAV, now, many);
    expect(r.filter((x) => x.kind === 'record')).toHaveLength(MAX_RECORD_RESULTS);
    expect(r.length).toBeLessThanOrEqual(8);
    expect(r.at(-1)?.kind).toBe('assistant');
  });

  // The cap used to be applied to the whole list, so a query matching a lot of
  // nav labels pushed BOTH the record block and the "see all results" row off
  // the end — silently, and worst for the single common words people actually
  // type. Both of these use a nav array big enough to reach the cap on nav
  // alone, because the small fixture above can never expose it.
  it('keeps records and "see all results" when nav matches alone would fill the cap', () => {
    const crowdedNav: CommandNavItem[] = Array.from({ length: 9 }, (_, i) => ({
      href: `/dashboard/family-${i}`, label: `Family ${'Aa'.repeat(i + 1)}`,
    }));
    // Precondition: more nav labels match than the whole list can hold, so it
    // is nav that has to give way — before the fix the reserved rows did.
    expect(crowdedNav.every((n) => navMatchScore('family', n.label) > 0)).toBe(true);
    expect(crowdedNav.length).toBeGreaterThan(MAX_RESULTS);
    expect(routeCommand('family', crowdedNav, now)).toHaveLength(MAX_RESULTS);

    const r = routeCommand('family', crowdedNav, now, RECORDS);
    expect(r.some((x) => x.kind === 'record')).toBe(true);
    expect(r.find((x) => x.kind === 'search')).toMatchObject({ kind: 'search', query: 'family' });
    expect(r.at(-1)?.kind).toBe('assistant');
    expect(r.length).toBeLessThanOrEqual(MAX_RESULTS);
    // Nav gave way, not the records — and the strongest nav match survived.
    expect(r[0]).toMatchObject({ kind: 'navigate', href: '/dashboard/family-0' });
  });

  it('keeps records and "see all results" against the REAL nav catalogue', () => {
    const realNav: CommandNavItem[] = NAV_CATALOG.map((n) => ({ href: n.href, label: n.label }));
    // "family" matches seven catalogue entries; before the reserved-slot fix
    // those seven filled every slot and this household's document vanished.
    const r = routeCommand('family', realNav, now, RECORDS);
    expect(r.some((x) => x.kind === 'record')).toBe(true);
    expect(r.some((x) => x.kind === 'search')).toBe(true);
    expect(r.at(-1)?.kind).toBe('assistant');
    expect(r.length).toBeLessThanOrEqual(MAX_RESULTS);
  });

  it('offers "see all results" once the query is long enough, whether or not records came back', () => {
    const withRecords = routeCommand('furnace warranty', NAV, now, RECORDS);
    const withNone = routeCommand('furnace warranty', NAV, now, []);
    for (const r of [withRecords, withNone]) {
      expect(r.find((x) => x.kind === 'search')).toMatchObject({
        kind: 'search', query: 'furnace warranty', href: searchHref('furnace warranty'),
      });
    }
  });

  it('does not offer the results page for a query too short to have been searched', () => {
    const short = 'x'.repeat(MIN_RECORD_QUERY - 1);
    expect(routeCommand(short, NAV, now).some((x) => x.kind === 'search')).toBe(false);
  });

  it('percent-encodes the query in the results-page link', () => {
    expect(searchHref('furnace & warranty')).toBe('/dashboard/search?q=furnace%20%26%20warranty');
  });

  it('changes nothing when no records are passed — the existing kinds keep their order', () => {
    const withArg = routeCommand('billing looks wrong', NAV, now, []);
    const withoutArg = routeCommand('billing looks wrong', NAV, now);
    expect(withArg).toEqual(withoutArg);
    expect(withArg.some((x) => x.kind === 'record')).toBe(false);
    const kinds = withArg.map((x) => x.kind);
    expect(kinds.indexOf('navigate')).toBeLessThan(kinds.indexOf('capture'));
    expect(kinds.at(-1)).toBe('assistant');
  });
});
