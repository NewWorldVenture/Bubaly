import { describe, it, expect } from 'vitest';
import { navMatchScore, routeCommand, type CommandNavItem } from '@/lib/command-bar/route';

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
