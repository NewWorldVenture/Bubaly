import { describe, it, expect } from 'vitest';
import {
  QUICK_ROUTE_CATALOG,
  availableQuickRoutes,
  defaultQuickRouteKeys,
  resolveQuickRoutes,
} from '@/lib/capture/quick-routes';

describe('availableQuickRoutes (tier gating)', () => {
  it('Free (level 0) excludes Basic/Plus-only routes', () => {
    const keys = availableQuickRoutes(0).map((r) => r.key);
    expect(keys).toContain('calendar');
    expect(keys).toContain('grocery');
    expect(keys).not.toContain('tasks');   // minLevel 1
    expect(keys).not.toContain('health');  // minLevel 1
    expect(keys).not.toContain('trip');    // minLevel 1
  });

  it('Basic (level 1) includes level 0 + level 1 routes', () => {
    const keys = availableQuickRoutes(1).map((r) => r.key);
    expect(keys).toContain('tasks');
    expect(keys).toContain('health');
    expect(keys).toContain('calendar');
  });

  it('never returns a route above the given level', () => {
    for (const level of [0, 1, 2]) {
      expect(availableQuickRoutes(level).every((r) => r.minLevel <= level)).toBe(true);
    }
  });
});

describe('defaultQuickRouteKeys', () => {
  it('returns the first N available routes for the tier', () => {
    expect(defaultQuickRouteKeys(0, 3)).toHaveLength(3);
    expect(defaultQuickRouteKeys(0, 3).every((k) =>
      QUICK_ROUTE_CATALOG.find((r) => r.key === k)!.minLevel <= 0,
    )).toBe(true);
  });
});

describe('resolveQuickRoutes', () => {
  it('falls back to the tier default when no saved selection', () => {
    const out = resolveQuickRoutes(null, 0).map((r) => r.key);
    expect(out).toEqual(defaultQuickRouteKeys(0));
  });

  it('honors saved order and selection', () => {
    const out = resolveQuickRoutes(['grocery', 'calendar'], 0).map((r) => r.key);
    expect(out).toEqual(['grocery', 'calendar']);
  });

  it('drops saved keys that are now locked (e.g. after a downgrade)', () => {
    // 'tasks' is Basic-only; a Free user must never see it even if saved.
    const out = resolveQuickRoutes(['calendar', 'tasks'], 0).map((r) => r.key);
    expect(out).toEqual(['calendar']);
  });

  it('drops unknown keys and falls back if nothing valid remains', () => {
    const out = resolveQuickRoutes(['does-not-exist'], 0).map((r) => r.key);
    expect(out).toEqual(defaultQuickRouteKeys(0));
  });
});
