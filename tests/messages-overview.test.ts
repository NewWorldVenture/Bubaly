import { describe, it, expect } from 'vitest';
import {
  convMatchesTab, previewText, isUnread, shortTime, summarizeConversations,
} from '../lib/messages/overview';

describe('convMatchesTab', () => {
  it('matches all, direct, group (incl. channel), announcement', () => {
    expect(convMatchesTab('direct', 'all')).toBe(true);
    expect(convMatchesTab('direct', 'direct')).toBe(true);
    expect(convMatchesTab('group', 'group')).toBe(true);
    expect(convMatchesTab('channel', 'group')).toBe(true);
    expect(convMatchesTab('group', 'direct')).toBe(false);
    expect(convMatchesTab('announcement', 'announcement')).toBe(true);
  });
});

describe('previewText', () => {
  const base = { sender_name: 'Mia Parker', sender_id: 'mia', attachment_name: null as string | null };
  it('prefixes You for own messages, first name for others', () => {
    expect(previewText({ ...base, kind: 'text', content: 'Hello' }, 'mia')).toBe('You: Hello');
    expect(previewText({ ...base, kind: 'text', content: 'Hi' }, 'me')).toBe('Mia: Hi');
  });
  it('labels non-text kinds', () => {
    expect(previewText({ ...base, kind: 'image', content: null }, 'me')).toBe('Mia: 📷 Photo');
    expect(previewText({ ...base, kind: 'file', content: null, attachment_name: 'Science.pdf' }, 'me')).toBe('Mia: 📎 Science.pdf');
    expect(previewText({ ...base, kind: 'voice', content: null }, 'me')).toBe('Mia: 🎤 Voice message');
  });
});

describe('isUnread', () => {
  it('is unread when another sender and not in read_by', () => {
    expect(isUnread({ sender_id: 'other', read_by: [] }, 'me')).toBe(true);
    expect(isUnread({ sender_id: 'other', read_by: ['me'] }, 'me')).toBe(false);
    expect(isUnread({ sender_id: 'me', read_by: [] }, 'me')).toBe(false);
  });
});

describe('shortTime', () => {
  const now = new Date('2025-05-13T12:00:00');
  it('formats today as time, then Yesterday, weekday, or date', () => {
    expect(shortTime('2025-05-13T09:41:00', now)).toMatch(/9:41/);
    expect(shortTime('2025-05-12T09:41:00', now)).toBe('Yesterday');
    expect(shortTime('2025-05-10T09:41:00', now)).toBe('Sat');
    expect(shortTime('2025-04-01T09:41:00', now)).toBe('4/1/25');
  });
});

describe('summarizeConversations', () => {
  it('picks the latest message per conversation and counts unread', () => {
    const msgs = [
      { conversation_id: 'a', created_at: '2025-05-01T10:00:00Z', kind: 'text', content: 'old', attachment_name: null, sender_name: 'X', sender_id: 'x', read_by: [] },
      { conversation_id: 'a', created_at: '2025-05-02T10:00:00Z', kind: 'text', content: 'new', attachment_name: null, sender_name: 'X', sender_id: 'x', read_by: [] },
      { conversation_id: 'a', created_at: '2025-05-03T10:00:00Z', kind: 'text', content: 'mine', attachment_name: null, sender_name: 'Me', sender_id: 'me', read_by: [] },
      { conversation_id: 'b', created_at: '2025-05-01T10:00:00Z', kind: 'text', content: 'read', attachment_name: null, sender_name: 'Y', sender_id: 'y', read_by: ['me'] },
    ];
    const { lastByConv, unreadByConv } = summarizeConversations(msgs, 'me');
    expect(lastByConv.get('a')?.content).toBe('mine');
    expect(unreadByConv.get('a')).toBe(2); // two from x, unread; mine doesn't count
    expect(unreadByConv.get('b')).toBeUndefined(); // read
  });
});
