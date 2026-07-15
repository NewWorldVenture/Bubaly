import { describe, it, expect } from 'vitest';
import {
  ADMIN_NOTE_KIND_META, adminNoteKindMeta, isAdminNoteKind, unreadCount, badgeText,
  filterAdminNotes, countByKind,
} from '@/lib/admin/notifications';

describe('admin notification kind meta', () => {
  it('has a label + tone for every kind', () => {
    for (const meta of Object.values(ADMIN_NOTE_KIND_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tone).toMatch(/^text-/);
    }
  });
  it('recognizes valid kinds and falls back to info', () => {
    expect(isAdminNoteKind('support_ticket')).toBe(true);
    expect(isAdminNoteKind('nope')).toBe(false);
    expect(adminNoteKindMeta('marketplace_report').label).toBe('Trust & Safety');
    expect(adminNoteKindMeta('nonsense')).toBe(ADMIN_NOTE_KIND_META.info);
  });
});

describe('unreadCount', () => {
  it('counts only unread rows', () => {
    expect(unreadCount([{ is_read: false }, { is_read: true }, { is_read: false }])).toBe(2);
    expect(unreadCount([])).toBe(0);
    expect(unreadCount([{ is_read: true }])).toBe(0);
  });
});

describe('badgeText', () => {
  it('renders 0 as empty, caps at 9+', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(250)).toBe('9+');
  });
});

describe('filterAdminNotes', () => {
  const rows = [
    { kind: 'feedback_new', is_read: false },
    { kind: 'feedback_new', is_read: true },
    { kind: 'subscription', is_read: false },
    { kind: 'github_error', is_read: true },
  ];

  it('returns everything for kind "all" and no unread filter', () => {
    expect(filterAdminNotes(rows, { kind: 'all' })).toHaveLength(4);
    expect(filterAdminNotes(rows, {})).toHaveLength(4);
  });

  it('filters by a single kind', () => {
    const out = filterAdminNotes(rows, { kind: 'feedback_new' });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.kind === 'feedback_new')).toBe(true);
  });

  it('filters to unread only', () => {
    const out = filterAdminNotes(rows, { unreadOnly: true });
    expect(out).toHaveLength(2);
    expect(out.every((r) => !r.is_read)).toBe(true);
  });

  it('combines kind + unreadOnly', () => {
    expect(filterAdminNotes(rows, { kind: 'feedback_new', unreadOnly: true })).toHaveLength(1);
    expect(filterAdminNotes(rows, { kind: 'github_error', unreadOnly: true })).toHaveLength(0);
  });
});

describe('countByKind', () => {
  it('tallies rows per kind', () => {
    expect(countByKind([
      { kind: 'feedback_new' }, { kind: 'feedback_new' }, { kind: 'subscription' },
    ])).toEqual({ feedback_new: 2, subscription: 1 });
    expect(countByKind([])).toEqual({});
  });
});
