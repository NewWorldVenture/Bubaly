// The household inbox's merge and its ranking.
//
// Three tables, one queue. What matters is the ORDER — a family looking at this
// screen is asking "what needs me first?" — and that "handled" is never claimed
// off anything but a row that says so.
import { describe, expect, it } from 'vitest';
import {
  countNeedsYou, daysUntil, rankFor, reasonFor, snippetOf, unifyInbox,
  type CommunicationRow, type InboxMessageRow, type PaperworkRow,
} from '@/lib/inbox/unify';

const NOW = new Date('2026-03-01T12:00:00Z');

function message(over: Partial<InboxMessageRow> = {}): InboxMessageRow {
  return {
    id: 'm1', channel: 'email', direction: 'inbound', from_addr: 'school@example.com',
    subject: 'Field trip', body: 'Please reply', ai_summary: null, ai_intent: 'personal',
    ai_handled: false, status: 'new', occurred_at: '2026-03-01T10:00:00Z', ...over,
  };
}
function paperwork(over: Partial<PaperworkRow> = {}): PaperworkRow {
  return {
    id: 'p1', kind: 'permission_slip', title: 'Permission slip', summary: 'Sign and return',
    sender: 'Lincoln Elementary', due_on: null, urgency: 'normal', status: 'needs_action',
    created_at: '2026-03-01T09:00:00Z', ...over,
  };
}
function communication(over: Partial<CommunicationRow> = {}): CommunicationRow {
  return {
    id: 'c1', channel: 'call', subject: 'Coach called', body: 'About Saturday', summary: null,
    category: 'sports', status: 'read', priority: 'normal', received_at: '2026-03-01T08:00:00Z', ...over,
  };
}

describe('reasonFor', () => {
  it('ranks an urgent classification above everything else', () => {
    expect(reasonFor({ intent: 'urgent', unread: false, now: NOW })).toBe('urgent');
    expect(reasonFor({ intent: null, urgency: 'urgent', unread: false, now: NOW })).toBe('urgent');
    expect(reasonFor({ intent: null, priority: 'urgent', unread: false, now: NOW })).toBe('urgent');
  });

  it('treats a deadline inside two days as urgent and inside a week as soon', () => {
    expect(reasonFor({ intent: null, dueOn: '2026-03-02', unread: false, now: NOW })).toBe('urgent');
    expect(reasonFor({ intent: null, dueOn: '2026-03-06', unread: false, now: NOW })).toBe('soon');
    expect(reasonFor({ intent: null, dueOn: '2026-04-06', unread: false, now: NOW })).toBe('recent');
  });

  it('treats an appointment or a delivery as soon, and an unlooked-at row as unread', () => {
    expect(reasonFor({ intent: 'appointment', unread: false, now: NOW })).toBe('soon');
    expect(reasonFor({ intent: 'delivery', unread: false, now: NOW })).toBe('soon');
    expect(reasonFor({ intent: 'personal', unread: true, now: NOW })).toBe('unread');
    expect(reasonFor({ intent: 'personal', unread: false, now: NOW })).toBe('recent');
  });

  it('orders the four reasons the way the queue reads them', () => {
    expect(rankFor('urgent')).toBeLessThan(rankFor('soon'));
    expect(rankFor('soon')).toBeLessThan(rankFor('unread'));
    expect(rankFor('unread')).toBeLessThan(rankFor('recent'));
  });
});

describe('daysUntil', () => {
  it('counts whole days and ignores a date it cannot parse', () => {
    expect(daysUntil('2026-03-04', NOW)).toBe(3);
    expect(daysUntil('2026-02-27', NOW)).toBe(-2);
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });
});

describe('snippetOf', () => {
  it('collapses whitespace and caps with an ellipsis', () => {
    expect(snippetOf('  two   lines\n here ')).toBe('two lines here');
    expect(snippetOf(null)).toBe('');
    expect(snippetOf('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('unifyInbox', () => {
  it('merges all three sources into one list with a stable shape', () => {
    const items = unifyInbox({
      messages: [message()],
      paperwork: [paperwork()],
      communications: [communication()],
      now: NOW,
    });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.source).sort()).toEqual(['communications', 'contact_center', 'paperwork']);
    for (const item of items) {
      expect(item).toMatchObject({
        kind: expect.any(String),
        id: expect.any(String),
        title: expect.any(String),
        snippet: expect.any(String),
        occurredAt: expect.any(String),
        source: expect.any(String),
        handled: expect.any(Boolean),
      });
      // Ids are namespaced per source so two tables cannot collide on a row id.
      expect(item.id).toContain(':');
    }
  });

  it('ranks urgent above a deadline, a deadline above unread, and unread above recency', () => {
    const items = unifyInbox({
      messages: [
        message({ id: 'recent', ai_intent: 'personal', status: 'read', occurred_at: '2026-03-01T11:59:00Z' }),
        message({ id: 'urgent', ai_intent: 'urgent', status: 'read', occurred_at: '2026-02-20T08:00:00Z' }),
        message({ id: 'unread', ai_intent: 'personal', status: 'new', occurred_at: '2026-02-25T08:00:00Z' }),
      ],
      paperwork: [paperwork({ id: 'soon', due_on: '2026-03-04', status: 'needs_action' })],
      now: NOW,
    });
    expect(items.map((i) => i.rowId)).toEqual(['urgent', 'soon', 'unread', 'recent']);
  });

  it('sinks handled rows below everything still waiting, however recent they are', () => {
    const items = unifyInbox({
      messages: [
        message({ id: 'done', ai_handled: true, ai_intent: 'urgent', occurred_at: '2026-03-01T11:59:00Z' }),
        message({ id: 'waiting', ai_handled: false, ai_intent: 'personal', status: 'read', occurred_at: '2026-02-01T08:00:00Z' }),
      ],
      now: NOW,
    });
    expect(items.map((i) => i.rowId)).toEqual(['waiting', 'done']);
    expect(items[1].handled).toBe(true);
  });

  it('reads "handled" only from the row, never from the intent', () => {
    const [item] = unifyInbox({ messages: [message({ ai_handled: false, ai_intent: 'appointment' })], now: NOW });
    expect(item.handled).toBe(false);
    const [flagged] = unifyInbox({ messages: [message({ ai_handled: true })], now: NOW });
    expect(flagged.handled).toBe(true);
  });

  it('offers "Handle it" only for an inbound contact-center row that is not already handled', () => {
    const [inbound] = unifyInbox({ messages: [message()], now: NOW });
    expect(inbound.canHandle).toBe(true);
    const [outbound] = unifyInbox({ messages: [message({ direction: 'outbound' })], now: NOW });
    expect(outbound.canHandle).toBe(false);
    const [handled] = unifyInbox({ messages: [message({ ai_handled: true })], now: NOW });
    expect(handled.canHandle).toBe(false);
    // Paperwork and log rows have their own surfaces; the intake is not their door.
    const [paper] = unifyInbox({ paperwork: [paperwork()], now: NOW });
    expect(paper.canHandle).toBe(false);
  });

  it('falls back through subject → sender → first line for a title, and never invents one', () => {
    const [noSubject] = unifyInbox({ messages: [message({ subject: null, from_addr: 'coach@team.org' })], now: NOW });
    expect(noSubject.title).toBe('coach@team.org');
    const [noSender] = unifyInbox({
      messages: [message({ subject: null, from_addr: null, body: '  Practice moved to 5pm\nsee you there' })],
      now: NOW,
    });
    expect(noSender.title).toBe('Practice moved to 5pm');
    const [nothing] = unifyInbox({ messages: [message({ subject: null, from_addr: null, body: null })], now: NOW });
    // Empty, not a hardcoded English label: the component renders a catalogue key.
    expect(nothing.title).toBe('');
  });

  it('sorts equal rows by recency and breaks the final tie deterministically', () => {
    const at = '2026-03-01T10:00:00Z';
    const first = unifyInbox({
      messages: [message({ id: 'b', occurred_at: at }), message({ id: 'a', occurred_at: at })],
      now: NOW,
    });
    const second = unifyInbox({
      messages: [message({ id: 'a', occurred_at: at }), message({ id: 'b', occurred_at: at })],
      now: NOW,
    });
    expect(first.map((i) => i.rowId)).toEqual(second.map((i) => i.rowId));
  });

  it('counts what still needs a person', () => {
    const items = unifyInbox({
      messages: [message({ id: 'a' }), message({ id: 'b', ai_handled: true })],
      paperwork: [paperwork({ id: 'p', status: 'needs_action' })],
      now: NOW,
    });
    expect(countNeedsYou(items)).toBe(2);
  });

  it('is empty, not broken, when every source is empty', () => {
    expect(unifyInbox({ now: NOW })).toEqual([]);
    expect(unifyInbox({ messages: null, paperwork: null, communications: null, now: NOW })).toEqual([]);
  });
});
