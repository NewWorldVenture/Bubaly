import { describe, it, expect } from 'vitest';
import {
  PROVIDERS, PROVIDERS_BY_ID, CATEGORY_ORDER, mergeConnections, groupByCategory,
  connectedCount, type ConnectionLike,
} from '@/lib/connections/providers';

describe('PROVIDERS registry', () => {
  it('has providers across all five categories with unique ids', () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    for (const c of CATEGORY_ORDER) expect(PROVIDERS.some((p) => p.category === c)).toBe(true);
  });
  it('resolves by id', () => {
    expect(PROVIDERS_BY_ID.google_calendar.name).toBe('Google Calendar');
  });

  it('marks only providers with a real OAuth/sync route as connectable', () => {
    expect(PROVIDERS_BY_ID.google_calendar.syncProvider).toBe('google');
    expect(PROVIDERS_BY_ID.outlook_calendar.syncProvider).toBe('microsoft');
    expect(PROVIDERS_BY_ID.apple_calendar.syncProvider).toBe('apple');
    expect(PROVIDERS_BY_ID.gmail.syncProvider).toBeUndefined();
    expect(PROVIDERS_BY_ID.plaid.syncProvider).toBeUndefined();
  });
});

describe('mergeConnections', () => {
  it('marks every provider disconnected when there are no rows', () => {
    const states = mergeConnections([]);
    expect(states).toHaveLength(PROVIDERS.length);
    expect(states.every((s) => !s.connected && s.status === 'disconnected')).toBe(true);
  });

  it('reflects a live connection with its account label', () => {
    const rows: ConnectionLike[] = [
      { provider: 'google_calendar', status: 'connected', account_label: 'mom@gmail.com', last_synced_at: '2026-07-05T00:00:00Z' },
    ];
    const gcal = mergeConnections(rows).find((s) => s.id === 'google_calendar')!;
    expect(gcal.connected).toBe(true);
    expect(gcal.status).toBe('connected');
    expect(gcal.accountLabel).toBe('mom@gmail.com');
  });

  it('syncing counts as connected; error and disconnected do not', () => {
    const rows: ConnectionLike[] = [
      { provider: 'gmail', status: 'syncing', account_label: null, last_synced_at: null },
      { provider: 'plaid', status: 'error', account_label: null, last_synced_at: null },
    ];
    const states = mergeConnections(rows);
    expect(states.find((s) => s.id === 'gmail')!.connected).toBe(true);
    const plaid = states.find((s) => s.id === 'plaid')!;
    expect(plaid.status).toBe('error');
    expect(plaid.connected).toBe(false);
  });

  it('a live row wins over a stale disconnected row for the same provider', () => {
    const rows: ConnectionLike[] = [
      { provider: 'instacart', status: 'disconnected', account_label: null, last_synced_at: null },
      { provider: 'instacart', status: 'connected', account_label: 'Home', last_synced_at: null },
    ];
    expect(mergeConnections(rows).find((s) => s.id === 'instacart')!.connected).toBe(true);
  });
});

describe('groupByCategory + connectedCount', () => {
  it('groups in canonical order', () => {
    const cats = groupByCategory(mergeConnections([])).map(([c]) => c);
    expect(cats).toEqual(CATEGORY_ORDER);
  });
  it('counts live connections', () => {
    const states = mergeConnections([
      { provider: 'google_calendar', status: 'connected', account_label: null, last_synced_at: null },
      { provider: 'gmail', status: 'syncing', account_label: null, last_synced_at: null },
      { provider: 'plaid', status: 'error', account_label: null, last_synced_at: null },
    ]);
    expect(connectedCount(states)).toBe(2);
  });
});
