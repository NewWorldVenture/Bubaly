// M5 "Needs Your Decision": three sources that never reached the "Needs you"
// queue before — a memory Bubaly inferred but nobody confirmed, a message to
// the family's own number/address waiting for a reply, and an open sign / pay
// / RSVP action on paperwork — map to NeedItems with the same urgency
// vocabulary and rank alongside the household's existing decisions.
import { describe, expect, it } from 'vitest';
import { buildHomeNeeds, type HomeNeedsInput } from '@/lib/home/needs-build';
import {
  factSuggestionToNeed, inboxMessageToNeed, paperworkActionsToNeeds, REPLY_INTENTS, PAPERWORK_DECISION_KINDS,
} from '@/lib/home/needs-sources';
import { rankNeedsAttention, summarizeNeeds } from '@/lib/home/needs-attention';

const now = new Date('2026-09-07T12:00:00Z');

const base: HomeNeedsInput = {
  approvals: [], renewals: [], documents: [], conflicts: [],
  pendingApprovals: 0, overdueMeds: false, overdueReminders: 0, dueTodayReminders: 0,
  pendingChores: 0, lowGrocery: false, openTodos: 0, now,
};

describe('factSuggestionToNeed', () => {
  it('maps an unconfirmed memory to a normal-urgency decision that links to the suggestion in the Playbook', () => {
    const n = factSuggestionToNeed({ id: 'sug-1', label: 'Go-to dinner', value: 'Taco night', created_at: '2026-09-06T09:00:00Z' }, now);
    expect(n).toEqual({
      id: 'fact_suggestion:sug-1',
      kind: 'fact_suggestion',
      title: 'Go-to dinner: Taco night',
      href: '/dashboard/playbook#suggestion-sug-1',
      urgency: 'normal',
      createdAt: '2026-09-06T09:00:00Z',
    });
  });

  it('escalates to urgent when the suggestion lapses within three days', () => {
    const n = factSuggestionToNeed({ id: 's', label: 'Coat size', value: '6', expires_at: '2026-09-09T00:00:00Z', created_at: 'x' }, now);
    expect(n?.urgency).toBe('urgent');
  });

  it('drops a suggestion that has already lapsed — confirmFact refuses it, so the card would be a dead button', () => {
    expect(factSuggestionToNeed({ id: 's', label: 'L', value: 'V', expires_at: '2026-09-01T00:00:00Z', created_at: 'x' }, now)).toBeNull();
  });
});

describe('inboxMessageToNeed', () => {
  const msg = {
    id: 'msg-1', direction: 'inbound', from_addr: '+15551234567', subject: null, ai_summary: 'Can we move the dentist to Thursday?',
    body: 'Hi, this is Dr. Patel’s office. Can we move the dentist to Thursday at 3?', ai_intent: 'appointment', status: 'new',
    occurred_at: '2026-09-07T10:00:00Z',
  };

  it('maps an unread appointment message to an urgent reply that deep-links into the Contact Center', () => {
    const n = inboxMessageToNeed(msg);
    expect(n).toEqual({
      id: 'inbox_message:msg-1',
      kind: 'inbox_message',
      title: 'Reply to +15551234567 — Can we move the dentist to Thursday?',
      href: '/dashboard/contact-center#inbox-message-msg-1',
      urgency: 'urgent',
      createdAt: '2026-09-07T10:00:00Z',
    });
  });

  it('treats a personal note as normal urgency and prefers the subject line when there is one', () => {
    const n = inboxMessageToNeed({ ...msg, id: 'm2', ai_intent: 'personal', subject: 'Playdate Saturday?', from_addr: 'grandma@example.com' });
    expect(n?.urgency).toBe('normal');
    expect(n?.title).toBe('Reply to grandma@example.com — Playdate Saturday?');
  });

  it('falls back to the body, then to a bare "Reply to" line', () => {
    expect(inboxMessageToNeed({ ...msg, ai_summary: null, body: '  Running   late  ' })?.title).toBe('Reply to +15551234567 — Running late');
    expect(inboxMessageToNeed({ ...msg, ai_summary: null, body: null, from_addr: null })?.title).toBe('Reply to an unknown sender');
  });

  it('returns null for anything read, archived, outbound, or of an intent the concierge files itself', () => {
    expect(inboxMessageToNeed({ ...msg, status: 'read' })).toBeNull();
    expect(inboxMessageToNeed({ ...msg, status: 'archived' })).toBeNull();
    expect(inboxMessageToNeed({ ...msg, direction: 'outbound' })).toBeNull();
    for (const intent of ['delivery', 'sales', 'spam', 'urgent', 'other', null]) {
      expect(inboxMessageToNeed({ ...msg, ai_intent: intent })).toBeNull();
    }
    expect(REPLY_INTENTS).toEqual(['appointment', 'personal']);
  });
});

describe('paperworkActionsToNeeds', () => {
  const item = {
    id: 'pw-1', title: 'Field trip permission slip', status: 'needs_action', urgency: 'soon', due_on: '2026-09-20',
    created_at: '2026-09-05T08:00:00Z',
    actions: [
      { kind: 'sign', label: 'Sign and return', due_on: null, amount: null, materialized_as: null, materialized_id: null },
      { kind: 'pay', label: 'Make the payment', due_on: '2026-09-09', amount: 45, materialized_as: null, materialized_id: null },
      { kind: 'rsvp', label: 'RSVP', due_on: null, amount: null, materialized_as: null, materialized_id: null },
      { kind: 'review', label: 'Review it', due_on: null, amount: null, materialized_as: null, materialized_id: null },
    ],
  };

  it('yields one item per open sign / pay / RSVP action, each linking to the paperwork item', () => {
    const out = paperworkActionsToNeeds(item, now);
    expect(out.map((n) => n.kind)).toEqual(['paperwork_sign', 'paperwork_pay', 'paperwork_rsvp']);
    expect(out.map((n) => n.id)).toEqual(['paperwork:pw-1:0', 'paperwork:pw-1:1', 'paperwork:pw-1:2']);
    expect(new Set(out.map((n) => n.href))).toEqual(new Set(['/dashboard/paperwork#paperwork-pw-1']));
    expect(PAPERWORK_DECISION_KINDS).toEqual(['sign', 'pay', 'rsvp']);
  });

  it('carries the amount and due date into the title, and the due date into the urgency', () => {
    const [sign, pay] = paperworkActionsToNeeds(item, now);
    // The item's own due date (12 whole days out — a date-only due_on parses
    // as UTC midnight, the same floor the renewal and document mappers use)
    // is not urgent; the payment's own due date (a day and a half out) is.
    expect(sign.title).toBe('Sign and return — Field trip permission slip · due in 12d');
    expect(sign.urgency).toBe('normal');
    expect(pay.title).toBe('Make the payment — Field trip permission slip · $45 · due in 1d');
    expect(pay.urgency).toBe('urgent');
  });

  it('is urgent when past due or when the triage marked the whole item urgent', () => {
    expect(paperworkActionsToNeeds({ ...item, due_on: '2026-09-01', actions: [item.actions[0]] }, now)[0]).toMatchObject({ urgency: 'urgent', title: expect.stringContaining('overdue') });
    expect(paperworkActionsToNeeds({ ...item, due_on: null, urgency: 'urgent', actions: [item.actions[0]] }, now)[0]).toMatchObject({ urgency: 'urgent', title: 'Sign and return — Field trip permission slip' });
  });

  it('skips actions already materialised into a reminder or event, and items that are done or archived', () => {
    const materialised = { ...item.actions[0], materialized_as: 'reminder', materialized_id: 'rem-1' };
    expect(paperworkActionsToNeeds({ ...item, actions: [materialised] }, now)).toEqual([]);
    expect(paperworkActionsToNeeds({ ...item, status: 'done' }, now)).toEqual([]);
    expect(paperworkActionsToNeeds({ ...item, status: 'archived' }, now)).toEqual([]);
    // Malformed jsonb never throws.
    expect(paperworkActionsToNeeds({ ...item, actions: null }, now)).toEqual([]);
    expect(paperworkActionsToNeeds({ ...item, actions: [null, 'sign', { kind: 42 }] }, now)).toEqual([]);
  });
});

describe('buildHomeNeeds with the M5 sources', () => {
  it('still returns nothing when the new sources are absent or empty', () => {
    expect(buildHomeNeeds(base)).toEqual([]);
    expect(buildHomeNeeds({ ...base, factSuggestions: [], inboxMessages: [], paperwork: [] })).toEqual([]);
  });

  it('merges all three into the one queue and ranks them with the existing items by urgency, then recency', () => {
    const ranked = rankNeedsAttention(buildHomeNeeds({
      ...base,
      aiApprovals: [{ id: 'ap-1', title: 'Book the plumber', runId: null, requestedAt: '2026-09-07T11:00:00Z' }],
      recommendations: [{ id: 'rec-1', title: 'Try a new dinner', created_at: '2026-09-07T08:00:00Z' }],
      factSuggestions: [{ id: 'sug-1', label: 'Go-to dinner', value: 'Taco night', created_at: '2026-09-07T09:00:00Z' }],
      inboxMessages: [
        { id: 'm-1', direction: 'inbound', from_addr: 'Dr. Patel', subject: 'Thursday?', ai_summary: null, body: null, ai_intent: 'appointment', status: 'new', occurred_at: '2026-09-07T10:30:00Z' },
        { id: 'm-2', direction: 'inbound', from_addr: 'FedEx', subject: null, ai_summary: 'Out for delivery', body: null, ai_intent: 'delivery', status: 'new', occurred_at: '2026-09-07T11:30:00Z' },
      ],
      paperwork: [{
        id: 'pw-1', title: 'Soccer registration', status: 'needs_action', urgency: 'normal', due_on: null, created_at: '2026-09-07T07:00:00Z',
        actions: [{ kind: 'pay', label: 'Make the payment', due_on: null, amount: 120, materialized_as: null, materialized_id: null }],
      }],
    }));
    // Urgent first (the AI approval, then the appointment reply — newest
    // first within a tier), then the normal-urgency items newest first. The
    // delivery notice never makes the list.
    expect(ranked.map((n) => n.id)).toEqual([
      'ai_approval:ap-1', 'inbox_message:m-1',
      'fact_suggestion:sug-1', 'recommendation:rec-1', 'paperwork:pw-1:0',
    ]);
    expect(summarizeNeeds(ranked).byKind).toEqual({ ai_approval: 1, inbox_message: 1, fact_suggestion: 1, recommendation: 1, paperwork_pay: 1 });
  });
});
