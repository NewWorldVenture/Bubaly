import { describe, it, expect } from 'vitest';
import { iconForType, groupByUser, type PendingNotification } from '@/lib/notifications/digest';

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
