import { describe, expect, it } from 'vitest';
import { clearConfirmedDraft, createThreadOwner, mergeThreadRows, reconcileLatestThreadRows, messageReadByOthers, shouldSendOnEnter } from '@/lib/messages/thread-state';
import { previewText } from '@/lib/messages/overview';

const row = (id: string, day: number, conversation_id = 'a') => ({ id, conversation_id, created_at: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`, deleted_at: null as string | null, content: id });

describe('message history and confirmed writes reconcile', () => {
  it('orders newest-first history pages chronologically without duplicates from realtime', () => {
    expect(mergeThreadRows([row('m3', 3)], [row('m3', 3), row('m2', 2), row('m1', 1)], 'a').map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
  });
  it('has a stable id tiebreaker for cursor pagination', () => {
    expect(mergeThreadRows([], [row('b', 1), row('a', 1)], 'a').map((item) => item.id)).toEqual(['a', 'b']);
  });
  it('does not admit another conversation into the active thread', () => {
    expect(mergeThreadRows([row('other-old', 1, 'b')], [row('other-new', 2, 'b'), row('mine', 3)], 'a').map((item) => item.id)).toEqual(['mine']);
  });
  it('replaces a saved row with its confirmed edit and retains soft-delete tombstones', () => {
    const deleted = { ...row('m1', 1), content: 'hidden', deleted_at: '2026-10-03T12:00:00Z' };
    expect(mergeThreadRows([row('m1', 1)], [deleted], 'a')).toEqual([deleted]);
  });
  it('removes an offline hard deletion when reconciling a fresh latest page', () => {
    expect(reconcileLatestThreadRows([row('older', 1), row('page-start', 2), row('deleted', 3), row('latest', 4)], [row('latest', 4), row('page-start', 2)], 'a').map((item) => item.id)).toEqual(['older', 'page-start', 'latest']);
    expect(reconcileLatestThreadRows([row('deleted', 1)], [], 'a')).toEqual([]);
  });
});

describe('asynchronous work belongs to a thread visit', () => {
  it('rejects a delayed response after A to B navigation', () => {
    const owner = createThreadOwner(); owner.select('a'); const ticket = owner.begin('history'); owner.select('b');
    expect(owner.accepts(ticket)).toBe(false);
  });
  it('also rejects the previous visit after A to B to A', () => {
    const owner = createThreadOwner(); owner.select('a'); const ticket = owner.capture(); owner.select('b'); owner.select('a');
    expect(owner.current(ticket)).toBe(false);
  });
  it('accepts only the latest overlapping refresh without invalidating older-page work', () => {
    const owner = createThreadOwner(); owner.select('a'); const first = owner.begin('history'); const older = owner.begin('older'); const latest = owner.begin('history');
    expect(owner.accepts(first)).toBe(false); expect(owner.accepts(older)).toBe(true); expect(owner.accepts(latest)).toBe(true);
  });
  it('revokes pending microphone and history work on unmount', () => {
    const owner = createThreadOwner(); owner.select('a'); const microphone = owner.capture(); const history = owner.begin('history'); owner.select(null);
    expect(owner.current(microphone)).toBe(false); expect(owner.accepts(history)).toBe(false);
  });
});

describe('composer ownership and keyboard behavior', () => {
  it('clears only the submitted draft after a confirmed send', () => {
    const draft = { text: 'Hello', reply: { id: 'm1' }, edit: null };
    expect(clearConfirmedDraft(draft, draft)).toEqual({ text: '', reply: null, edit: null });
    const newer = { ...draft, text: 'Next message' };
    expect(clearConfirmedDraft(newer, draft)).toBe(newer);
  });
  it('preserves a newly selected reply even when the text is identical', () => {
    const draft = { text: 'Yes', reply: { id: 'm1' }, edit: null };
    const newer = { ...draft, reply: { id: 'm2' } };
    expect(clearConfirmedDraft(newer, draft)).toBe(newer);
  });
  it('sends plain Enter, preserving Shift+Enter and IME confirmation', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });
  it('does not call a sender-only receipt read by someone else', () => {
    expect(messageReadByOthers([], 'me')).toBe(false); expect(messageReadByOthers(['me'], 'me')).toBe(false);
    expect(messageReadByOthers(['me', 'you'], 'me')).toBe(true);
  });
  it('previews current audio recordings just like legacy voice messages', () => {
    expect(previewText({ kind: 'audio', content: null, attachment_name: 'voice.webm', sender_name: 'Alex', sender_id: 'me' }, 'me')).toContain('Voice message');
  });
});
