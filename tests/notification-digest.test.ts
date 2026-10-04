import { describe, it, expect } from 'vitest';
import { iconForType, groupByUser, digestTimeZone, type PendingNotification } from '@/lib/notifications/digest';

describe('iconForType', () => {
  it('maps known types to icons', () => {
    expect(iconForType('medication_due')).toBe('💊');
    expect(iconForType('chore_due')).toBe('✅');
    expect(iconForType('document_expiry')).toBe('📄');
    expect(iconForType('system')).toBe('🔔');
  });
});

describe('groupByUser', () => {
  const n = (id: string, user_id: string | null): PendingNotification => ({ id, user_id, type: 'system', title: 't', body: null });

  it('groups by recipient preserving order', () => {
    const groups = groupByUser([n('a', 'u1'), n('b', 'u2'), n('c', 'u1')]);
    expect([...groups.keys()].sort()).toEqual(['u1', 'u2']);
    expect(groups.get('u1')!.map((x) => x.id)).toEqual(['a', 'c']);
    expect(groups.get('u2')!.map((x) => x.id)).toEqual(['b']);
  });

  it('drops whole-family (null user) rows', () => {
    const groups = groupByUser([n('a', null), n('b', 'u1')]);
    expect(groups.has('u1')).toBe(true);
    expect([...groups.values()].flat().map((x) => x.id)).toEqual(['b']);
  });
});

describe('digestTimeZone', () => {
  const row = (family_id: string) => ({ family_id });
  const zones = new Map([['A', 'America/Los_Angeles'], ['B', 'Pacific/Kiritimati'], ['C', 'America/Los_Angeles']]);

  it("is the family's zone when every row is that family's", () => {
    expect(digestTimeZone([row('A'), row('A')], zones)).toBe('America/Los_Angeles');
  });
  it('is the shared zone when every family in the digest keeps the same one', () => {
    expect(digestTimeZone([row('A'), row('C')], zones)).toBe('America/Los_Angeles');
  });
  it("is null when the families keep different zones — no one family's day applies, whichever row comes first", () => {
    expect(digestTimeZone([row('A'), row('B')], zones)).toBeNull();
    expect(digestTimeZone([row('B'), row('A')], zones)).toBeNull();
  });
  it('dates a batch whose zones could not be read in an explicit UTC, and an unread family next to a read one as mixed', () => {
    expect(digestTimeZone([row('A'), row('B')], new Map())).toBe('UTC');
    expect(digestTimeZone([row('A'), row('Z')], zones)).toBeNull();
  });
});
