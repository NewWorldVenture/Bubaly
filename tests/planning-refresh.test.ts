import { describe, it, expect } from 'vitest';
import { shouldRefresh, needsRefresh, shouldAutoRefreshGraph, summarizeSweep, DEFAULT_TTL_MINUTES, type RefreshOutcome } from '@/lib/planning/refresh';

const NOW = new Date('2026-07-06T12:00:00Z');

describe('shouldAutoRefreshGraph (on-read throttle)', () => {
  it('never refreshes a clean family, however stale', () => {
    expect(shouldAutoRefreshGraph({ dirty: false, refreshedAt: null, now: NOW })).toBe(false);
  });
  it('refreshes a dirty family that was never (or long ago) refreshed', () => {
    expect(shouldAutoRefreshGraph({ dirty: true, refreshedAt: null, now: NOW })).toBe(true);
    const old = new Date(NOW.getTime() - 30 * 60_000); // 30 min ago
    expect(shouldAutoRefreshGraph({ dirty: true, refreshedAt: old, now: NOW })).toBe(true);
  });
  it('throttles a dirty family refreshed within the cooldown', () => {
    const recent = new Date(NOW.getTime() - 3 * 60_000); // 3 min ago < 10 min cooldown
    expect(shouldAutoRefreshGraph({ dirty: true, refreshedAt: recent, now: NOW })).toBe(false);
  });
  it('honors a custom cooldown', () => {
    const t = new Date(NOW.getTime() - 3 * 60_000);
    expect(shouldAutoRefreshGraph({ dirty: true, refreshedAt: t, now: NOW, cooldownMinutes: 1 })).toBe(true);
  });
});

describe('shouldRefresh', () => {
  it('refreshes when never refreshed before', () => {
    expect(shouldRefresh(null, NOW)).toBe(true);
    expect(shouldRefresh(undefined, NOW)).toBe(true);
  });

  it('refreshes when older than the TTL', () => {
    const old = new Date(NOW.getTime() - (DEFAULT_TTL_MINUTES + 1) * 60_000).toISOString();
    expect(shouldRefresh(old, NOW)).toBe(true);
  });

  it('skips when refreshed within the TTL', () => {
    const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // 1h ago, TTL 6h
    expect(shouldRefresh(recent, NOW)).toBe(false);
  });

  it('accepts a Date as well as a string', () => {
    expect(shouldRefresh(new Date(NOW.getTime() - 10 * 60_000), NOW)).toBe(false);
  });

  it('refreshes on an unparseable timestamp (fail-open)', () => {
    expect(shouldRefresh('not-a-date', NOW)).toBe(true);
  });

  it('honours a custom TTL', () => {
    const t = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    expect(shouldRefresh(t, NOW, 15)).toBe(true);  // 30m old, 15m TTL
    expect(shouldRefresh(t, NOW, 60)).toBe(false); // 30m old, 60m TTL
  });
});

describe('needsRefresh (event-driven gate)', () => {
  it('always refreshes a dirty family, even if just refreshed', () => {
    const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(needsRefresh({ dirty: true, lastRefreshedAt: recent, now: NOW })).toBe(true);
  });
  it('falls back to TTL staleness when not dirty', () => {
    const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // 1h, TTL 6h
    expect(needsRefresh({ dirty: false, lastRefreshedAt: recent, now: NOW })).toBe(false);
    const old = new Date(NOW.getTime() - (DEFAULT_TTL_MINUTES + 1) * 60_000).toISOString();
    expect(needsRefresh({ dirty: false, lastRefreshedAt: old, now: NOW })).toBe(true);
  });
  it('refreshes a never-refreshed family', () => {
    expect(needsRefresh({ dirty: false, lastRefreshedAt: null, now: NOW })).toBe(true);
  });
});

describe('summarizeSweep', () => {
  it('counts refreshed / skipped / failures', () => {
    const outcomes: RefreshOutcome[] = [
      { familyId: 'a', ok: true, entities: 10, edges: 8, plans: 2 },
      { familyId: 'b', ok: true, skipped: true },
      { familyId: 'c', ok: false, error: 'boom' },
      { familyId: 'd', ok: true, entities: 0, edges: 0, plans: 0 },
    ];
    expect(summarizeSweep(outcomes)).toEqual({ families: 4, refreshed: 2, skipped: 1, failures: 1 });
  });

  it('handles an empty sweep', () => {
    expect(summarizeSweep([])).toEqual({ families: 0, refreshed: 0, skipped: 0, failures: 0 });
  });
});
