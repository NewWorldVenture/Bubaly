// M20's missing half: an inbound message becomes work, not a line in a log.
//
// Before this, `recordInboundMessage` was storage-only — the audit's finding was
// that inbound mail is "classified and auto-replied but never becomes bills,
// receipts, reservations, forms, events or tasks". `routeInboundToPlanner` is
// the bridge, and what it must get right is narrow and load-bearing:
//
//   * only actionable intents are filed (spam and sales do not open runs);
//   * the SAME intake every other entry uses, so trust gating and the approval
//     spine are the ones already in place — not a private write path;
//   * `ai_handled` is stamped ONLY after a request is persisted;
//   * a redelivered webhook re-finds its request instead of planning twice;
//   * an emailed bill or reservation also lands in `paperwork_items`, with a
//     kind the 0169 CHECK constraint actually admits.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { shouldPlanInbound } from '@/lib/contact-center/routing';
import { fileInboundPaperwork, recordInboundMessage, routeInboundToPlanner } from '@/lib/contact-center/server';

const FAMILY = 'family-1';
const NOW = new Date('2026-03-01T12:00:00Z');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** A stand-in for `submitRequest` that records what it was asked to file. */
function fakeIntake(overrides: { ok?: boolean } = {}) {
  const calls: { text: string; clientRequestId: string | null }[] = [];
  const submit = vi.fn(async (_scope: unknown, input: { text: string; clientRequestId?: string | null }) => {
    calls.push({ text: input.text, clientRequestId: input.clientRequestId ?? null });
    if (overrides.ok === false) return { ok: false as const, error: 'planner unavailable', retryable: true };
    return {
      ok: true as const,
      data: { requestId: `req-${calls.length}`, runId: `run-${calls.length}`, planId: null, outcome: 'plan', summary: 'ok', redirect: null },
    };
  });
  return { submit, calls };
}

beforeEach(() => {
  // The column defaults 0214 actually declares, so "not handled" is `false` in
  // the fake exactly as it is in Postgres — an `undefined` would let a missing
  // stamp pass for an unstamped row.
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { family_inbox_messages: { ai_handled: false, status: 'new', direction: 'inbound' } },
  });
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'America/Chicago' }]);
});

type Admin = Parameters<typeof routeInboundToPlanner>[0];
const admin = () => db as unknown as Admin;

describe('shouldPlanInbound', () => {
  it('files household work and leaves noise alone', () => {
    expect(shouldPlanInbound('appointment')).toBe(true);
    expect(shouldPlanInbound('delivery')).toBe(true);
    expect(shouldPlanInbound('personal')).toBe(true);
    expect(shouldPlanInbound('sales')).toBe(false);
    expect(shouldPlanInbound('spam')).toBe(false);
    expect(shouldPlanInbound('other')).toBe(false);
  });

  it('leaves urgent to the escalation path rather than racing it with a run', () => {
    expect(shouldPlanInbound('urgent')).toBe(false);
  });
});

describe('recordInboundMessage', () => {
  it('returns the id of the row it filed, so the caller can stamp it', async () => {
    const filed = await recordInboundMessage(admin(), {
      familyId: FAMILY, channel: 'sms', from: '+15551234567', body: 'Can we move Thursday?',
      providerRef: 'SM123',
    });
    expect(filed.messageId).toBeTruthy();
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('family_inbox_messages')[0]).toMatchObject({ family_id: FAMILY, channel: 'sms', direction: 'inbound' });
  });
});

describe('routeInboundToPlanner', () => {
  it('files an appointment through the intake and marks the row handled', async () => {
    const filed = await recordInboundMessage(admin(), {
      familyId: FAMILY, channel: 'sms', body: 'Can we move Thursday to 4pm?',
      providerRef: 'SM1', aiIntent: 'appointment',
    });
    const intake = fakeIntake();

    const out = await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'sms', messageId: filed.messageId,
      body: 'Can we move Thursday to 4pm?', intent: 'appointment', providerRef: 'SM1',
      submit: intake.submit as never, now: NOW,
    });

    expect(out.routed).toBe(true);
    expect(out.requestId).toBe('req-1');
    expect(out.runId).toBe('run-1');
    expect(intake.submit).toHaveBeenCalledTimes(1);
    expect(intake.calls[0].text).toContain('Thursday');
    // The stamp is on the row, which is the only place the UI reads it from.
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(true);
  });

  it('does not file spam or a sales pitch, and touches nothing', async () => {
    const filed = await recordInboundMessage(admin(), {
      familyId: FAMILY, channel: 'email', body: 'Limited time offer — save $200 on gutters',
      providerRef: 'EM1', aiIntent: 'sales',
    });
    const intake = fakeIntake();

    const out = await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'email', messageId: filed.messageId,
      body: 'Limited time offer', intent: 'sales', providerRef: 'EM1',
      submit: intake.submit as never, now: NOW,
    });

    expect(out).toMatchObject({ routed: false, reason: 'not_actionable', requestId: null });
    expect(intake.submit).not.toHaveBeenCalled();
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(false);
  });

  it('leaves the row unhandled when the intake fails — no claim without a request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const filed = await recordInboundMessage(admin(), {
      familyId: FAMILY, channel: 'sms', body: 'Package left at the side door',
      providerRef: 'SM2', aiIntent: 'delivery',
    });
    const intake = fakeIntake({ ok: false });

    const out = await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'sms', messageId: filed.messageId,
      body: 'Package left at the side door', intent: 'delivery', providerRef: 'SM2',
      submit: intake.submit as never, now: NOW,
    });

    expect(out).toMatchObject({ routed: false, reason: 'intake_failed', requestId: null });
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('gives the request the provider ref as its client id, so a redelivery is not a second run', async () => {
    const intake = fakeIntake();
    await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'email', messageId: null, subject: 'Dentist',
      body: 'Confirming Tuesday', intent: 'appointment', providerRef: 'msg-abc',
      submit: intake.submit as never, now: NOW,
    });
    expect(intake.calls[0].clientRequestId).toBe('inbound:email:msg-abc');
  });

  it('joins the subject and the body so the planner reads what the sender wrote', async () => {
    const intake = fakeIntake();
    await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'email', messageId: null,
      subject: 'Soccer practice moved', body: 'It is now 5pm on Wednesday.',
      intent: 'personal', providerRef: null, submit: intake.submit as never, now: NOW,
    });
    expect(intake.calls[0].text).toBe('Soccer practice moved\n\nIt is now 5pm on Wednesday.');
  });

  it('refuses to file an empty message', async () => {
    const intake = fakeIntake();
    const out = await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'sms', messageId: null, body: '   ',
      intent: 'personal', providerRef: null, submit: intake.submit as never, now: NOW,
    });
    expect(out).toMatchObject({ routed: false, reason: 'no_text' });
    expect(intake.submit).not.toHaveBeenCalled();
  });

  it('stops when the family cannot be identified, rather than acting for a household it could not read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const intake = fakeIntake();
    const out = await routeInboundToPlanner(admin(), {
      familyId: 'no-such-family', channel: 'sms', messageId: null, body: 'Confirming Tuesday',
      intent: 'appointment', providerRef: null, submit: intake.submit as never, now: NOW,
    });
    expect(out).toMatchObject({ routed: false, reason: 'no_scope' });
    expect(intake.submit).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('files an emailed bill as paperwork alongside the run', async () => {
    const intake = fakeIntake();
    const out = await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'email', messageId: null, subject: 'Water bill',
      body: 'Invoice attached. Amount due: $45.00 by March 9.',
      intent: 'personal', providerRef: 'EM9', submit: intake.submit as never, now: NOW,
    });
    expect(out.paperworkItemId).toBeTruthy();
    const [item] = db.table('paperwork_items');
    expect(item).toMatchObject({ family_id: FAMILY, kind: 'bill_or_payment', due_on: '2026-03-09' });
  });

  it('does not file paperwork for a text message — only email carries the attachments', async () => {
    const intake = fakeIntake();
    await routeInboundToPlanner(admin(), {
      familyId: FAMILY, channel: 'sms', messageId: null,
      body: 'Invoice attached. Amount due: $45.00 by March 9.',
      intent: 'personal', providerRef: null, submit: intake.submit as never, now: NOW,
    });
    expect(db.table('paperwork_items')).toHaveLength(0);
  });
});

describe('fileInboundPaperwork', () => {
  it('stores a receipt under a kind the CHECK constraint admits, keeping the real kind in meta', async () => {
    const id = await fileInboundPaperwork(admin(), FAMILY, 'Your receipt from Corner Hardware. Total charged $63.40.', NOW);
    expect(id).toBeTruthy();
    const [item] = db.table('paperwork_items');
    // 0169's CHECK has no 'receipt'; writing one would be a 23514 that loses the row.
    expect(item.kind).toBe('bill_or_payment');
    expect(item.meta).toMatchObject({ triage_kind: 'receipt', source: 'inbound_email' });
  });

  it('stores a reservation as the event kind, with its date', async () => {
    const id = await fileInboundPaperwork(admin(), FAMILY, 'Reservation confirmed. Table for 4 on March 8.', NOW);
    expect(id).toBeTruthy();
    const [item] = db.table('paperwork_items');
    expect(item.kind).toBe('event_flyer');
    expect(item.meta).toMatchObject({ triage_kind: 'reservation' });
    expect(item.due_on).toBe('2026-03-08');
  });

  it('files nothing when triage recognises nothing', async () => {
    const id = await fileInboundPaperwork(admin(), FAMILY, 'hey are you around later', NOW);
    expect(id).toBeNull();
    expect(db.table('paperwork_items')).toHaveLength(0);
  });
});
