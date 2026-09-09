// The Expo app's pure modules are tested from the root suite (no React Native
// runtime needed): theme resolution, secure-storage chunking, family selection,
// date formatting in the family time zone, chore completion, and the /api/ai
// JSON transport contract.
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEME_STORAGE_KEY, isThemePreference, nextTheme, resolveTheme } from '@/mobile/src/theme/theme-core';
import { DEFAULT_THEME as WEB_DEFAULT_THEME, THEME_KEY as WEB_THEME_KEY, resolveTheme as webResolveTheme } from '@/components/theme/theme-core';
import { SECURE_CHUNK_SIZE, chunkKey, createChunkedStore, splitChunks, type KeyValueStore } from '@/mobile/src/lib/chunked-storage';
import { pickActiveFamily } from '@/mobile/src/lib/family';
import { dayKey, dayLabel, dueLabel, formatTime, greeting, groupByDay, shiftDays } from '@/mobile/src/lib/format';
import { completionPatch, isOpenChore, statusLabel } from '@/mobile/src/lib/chores-core';
import { buildAssistantRequest, parseAssistantResponse } from '@/mobile/src/lib/assistant-core';
import { friendlyAuthError, validateCredentials } from '@/mobile/src/lib/auth-core';
import { palette } from '@/design/tokens';

describe('mobile theme mirrors the web theme', () => {
  it('shares the default (dark) and the storage key', () => {
    expect(DEFAULT_THEME).toBe(WEB_DEFAULT_THEME);
    expect(THEME_STORAGE_KEY).toBe(WEB_THEME_KEY);
  });
  it('resolves preferences exactly like the web', () => {
    for (const pref of ['dark', 'light', 'system'] as const) {
      for (const scheme of ['light', 'dark', null] as const) {
        expect(resolveTheme(pref, scheme)).toBe(webResolveTheme(pref, scheme === 'light'));
      }
    }
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
  });
  it('uses the shared palette for both modes', () => {
    expect(palette('dark').brand).toBe('rgb(116, 75, 232)');
    expect(palette('light').bg).toBe('rgb(245, 247, 252)');
  });
});

describe('chunked secure storage', () => {
  function memoryStore(): KeyValueStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: async (k) => map.get(k) ?? null,
      setItem: async (k, v) => { map.set(k, v); },
      removeItem: async (k) => { map.delete(k); },
    };
  }

  it('stores small values as-is and large values in chunks that round-trip', async () => {
    const backing = memoryStore();
    const store = createChunkedStore(backing, 10);
    await store.setItem('k', 'short');
    expect(backing.map.get('k')).toBe('short');
    expect(await store.getItem('k')).toBe('short');

    const big = 'x'.repeat(25) + 'y'.repeat(7);
    await store.setItem('k', big);
    expect(backing.map.get('k')).toBe('chunks:4');
    expect(backing.map.get(chunkKey('k', 3))).toBe('yy');
    expect(await store.getItem('k')).toBe(big);
    expect(splitChunks(big, 10)).toHaveLength(4);
  });

  it('cleans up stale chunks when a value shrinks and on removal', async () => {
    const backing = memoryStore();
    const store = createChunkedStore(backing, 10);
    await store.setItem('k', 'a'.repeat(35));
    expect([...backing.map.keys()].sort()).toEqual(['k', 'k.0', 'k.1', 'k.2', 'k.3']);
    await store.setItem('k', 'b'.repeat(15));
    expect([...backing.map.keys()].sort()).toEqual(['k', 'k.0', 'k.1']);
    await store.setItem('k', 'tiny');
    expect([...backing.map.keys()]).toEqual(['k']);
    await store.setItem('k', 'c'.repeat(22));
    await store.removeItem('k');
    expect(backing.map.size).toBe(0);
  });

  it('reads a torn write as no value and defaults to a keychain-safe chunk size', async () => {
    const backing = memoryStore();
    const store = createChunkedStore(backing, 10);
    await store.setItem('k', 'z'.repeat(30));
    backing.map.delete('k.1');
    expect(await store.getItem('k')).toBeNull();
    expect(await store.getItem('missing')).toBeNull();
    expect(SECURE_CHUNK_SIZE).toBeLessThan(2048);
    expect(splitChunks('', 10)).toEqual(['']);
  });
});

describe('pickActiveFamily', () => {
  const rows = [
    { id: 'm1', family_id: 'fam-1', role: 'parent', display_name: 'Dan', families: { name: 'One', timezone: 'America/New_York' } },
    { id: 'm2', family_id: 'fam-2', role: 'adult', display_name: 'Dan', families: { name: 'Two', timezone: null } },
  ];
  it('prefers the stored active family and falls back to the first membership', () => {
    expect(pickActiveFamily(rows, 'fam-2')).toEqual({ familyId: 'fam-2', familyName: 'Two', timezone: 'UTC', memberId: 'm2', role: 'adult', displayName: 'Dan' });
    expect(pickActiveFamily(rows, null)?.familyId).toBe('fam-1');
    expect(pickActiveFamily(rows, 'fam-9')?.familyId).toBe('fam-1');
  });
  it('ignores memberships whose family row is missing', () => {
    expect(pickActiveFamily([{ ...rows[0], families: null }], null)).toBeNull();
    expect(pickActiveFamily([], null)).toBeNull();
  });
});

describe('formatting in the family time zone', () => {
  const tz = 'America/New_York';
  const now = new Date('2026-09-05T15:00:00Z'); // 11:00 AM in New York

  it('keys and labels days in the family zone, not UTC', () => {
    expect(dayKey(new Date('2026-09-06T02:30:00Z'), tz)).toBe('2026-09-05'); // still Sept 5 in NY
    expect(dayLabel(new Date('2026-09-06T02:30:00Z'), tz, now)).toBe('Today');
    expect(dayLabel(shiftDays(now, 1), tz, now)).toBe('Tomorrow');
    expect(dayLabel(new Date('2026-09-08T16:00:00Z'), tz, now)).toBe('Tue, Sep 8');
    expect(dayKey(now, 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formats times and all-day events', () => {
    expect(formatTime('2026-09-05T20:00:00Z', tz)).toBe('4:00 PM');
    expect(formatTime('2026-09-05T20:00:00Z', tz, true)).toBe('All day');
  });

  it('groups events by day in order', () => {
    const items = [
      { id: 'b', at: '2026-09-06T14:00:00Z' },
      { id: 'a', at: '2026-09-05T18:00:00Z' },
      { id: 'c', at: '2026-09-06T20:00:00Z' },
    ];
    const groups = groupByDay(items, (i) => i.at, tz, now);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['a']],
      ['Tomorrow', ['b', 'c']],
    ]);
  });

  it('describes due dates', () => {
    expect(dueLabel(null, tz, now)).toBe('No due date');
    expect(dueLabel('nope', tz, now)).toBe('No due date');
    expect(dueLabel('2026-09-03T12:00:00Z', tz, now)).toBe('Overdue · Sep 3');
    expect(dueLabel('2026-09-05T21:00:00Z', tz, now)).toBe('Due today · 5:00 PM');
    expect(dueLabel('2026-09-06T21:00:00Z', tz, now)).toBe('Due Tomorrow');
    expect(dueLabel('2026-09-10T21:00:00Z', tz, now)).toBe('Due Thu, Sep 10');
  });

  it('greets by local hour', () => {
    expect(greeting(new Date('2026-09-05T12:00:00Z'), tz)).toBe('Good morning'); // 8 AM NY
    expect(greeting(new Date('2026-09-05T18:00:00Z'), tz)).toBe('Good afternoon');
    expect(greeting(new Date('2026-09-05T23:00:00Z'), tz)).toBe('Good evening');
    expect(greeting(new Date('2026-09-05T06:00:00Z'), tz)).toBe('Good night');
  });
});

describe('chore completion', () => {
  const now = new Date('2026-09-05T15:00:00Z');
  it('only ever submits — approval and payout stay manager/server decisions (migration 0223)', () => {
    expect(completionPatch(now)).toEqual({ status: 'submitted', submitted_at: now.toISOString() });
    expect(isOpenChore('todo')).toBe(true);
    expect(isOpenChore('in_progress')).toBe(true);
    expect(isOpenChore('submitted')).toBe(false);
    expect(isOpenChore('approved')).toBe(false);
  });
  it('labels statuses for people', () => {
    expect(statusLabel('submitted')).toBe('Waiting for approval');
    expect(statusLabel('approved')).toBe('Done');
    expect(statusLabel('custom')).toBe('custom');
  });
});

describe('/api/ai JSON transport contract', () => {
  it('builds a bearer-authenticated JSON request against /api/ai', () => {
    const { url, init } = buildAssistantRequest({ apiUrl: 'https://www.bubaly.com/', token: 'jwt', conversationId: 'c', message: 'hi' });
    expect(url).toBe('https://www.bubaly.com/api/ai?mode=json');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer jwt' });
    expect(JSON.parse(String(init.body))).toEqual({ conversationId: 'c', message: 'hi', stream: false });
  });

  it('parses a successful reply, normalising actions', () => {
    const parsed = parseAssistantResponse(200, { conversationId: 'c', content: 'Done.', actions: [{ name: 'add_chore', ok: true, summary: 'Added.' }, { name: 'x' }, null], persisted: true, model: 'm' });
    expect(parsed).toEqual({ ok: true, reply: { conversationId: 'c', content: 'Done.', actions: [{ name: 'add_chore', ok: true, summary: 'Added.' }, { name: 'x', ok: true, summary: '' }], persisted: true, model: 'm' } });
  });

  it('maps failures to friendly copy by code, status, or server message', () => {
    expect(parseAssistantResponse(401, { error: 'x', code: 'invalid_token' })).toMatchObject({ ok: false, code: 'invalid_token', error: 'Your session expired. Sign in again to continue.' });
    expect(parseAssistantResponse(403, { code: 'needs_family' })).toMatchObject({ ok: false, error: 'Finish setting up your family on the web app first.' });
    expect(parseAssistantResponse(429, {})).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(parseAssistantResponse(400, { error: 'Message is required' })).toMatchObject({ ok: false, error: 'Message is required' });
    expect(parseAssistantResponse(500, null)).toMatchObject({ ok: false, error: 'Bubaly hit a snag. Try again in a moment.' });
    expect(parseAssistantResponse(200, { content: 42 })).toMatchObject({ ok: false });
  });
});

describe('auth helpers', () => {
  it('validates credentials before hitting the network', () => {
    expect(validateCredentials('', 'x')).toBe('Enter your email.');
    expect(validateCredentials('nope', 'x')).toBe('That doesn’t look like an email address.');
    expect(validateCredentials('a@b.co', '')).toBe('Enter your password.');
    expect(validateCredentials(' a@b.co ', 'pw')).toBeNull();
  });
  it('translates Supabase auth errors', () => {
    expect(friendlyAuthError('Invalid login credentials')).toBe('That email and password don’t match.');
    expect(friendlyAuthError('Email not confirmed')).toContain('Confirm your email');
    expect(friendlyAuthError('Request rate limit reached')).toContain('Too many attempts');
    expect(friendlyAuthError('Network request failed')).toContain('connection');
    expect(friendlyAuthError('Weird')).toBe('Weird');
    expect(friendlyAuthError(null)).toBe('Something went wrong. Please try again.');
  });
});
