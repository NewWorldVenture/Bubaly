// Receipts and reservations, and the column that cannot hold them yet.
//
// Triage now recognises two more kinds. `paperwork_items.kind` does NOT: its
// CHECK constraint (0169) predates them, so writing 'receipt' would be a 23514
// that loses the row entirely. The mapping is therefore part of the contract,
// not an implementation detail, and this pins both halves — what triage sees,
// and what the database is allowed to be told.
import { describe, expect, it, vi } from 'vitest';
import {
  STORED_PAPERWORK_KINDS, classifyPaperwork, kindLabel, paperworkKindFields,
  storedPaperworkKind, triagePaperwork, type PaperworkKind,
} from '@/lib/paperwork/triage';

// The paperwork action is a `'use server'` module; these three are all it
// reaches for that a test cannot supply, and the payload builder touches none
// of them.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: vi.fn(), createServiceClient: vi.fn() }));

import { paperworkInsertRow } from '@/app/(app)/dashboard/paperwork/actions';

const NOW = new Date('2026-03-01T12:00:00Z');

/** Every kind triage can return — the list the mapping must be total over. */
const ALL_KINDS: PaperworkKind[] = [
  'permission_slip', 'school_notice', 'medical_form', 'sports',
  'bill_or_payment', 'event_flyer', 'receipt', 'reservation', 'other',
];

describe('classifyPaperwork — receipts', () => {
  it('recognises the ways a receipt announces itself', () => {
    expect(classifyPaperwork('Your receipt from Corner Hardware')).toBe('receipt');
    expect(classifyPaperwork('Thank you for your order! It ships Tuesday.')).toBe('receipt');
    expect(classifyPaperwork('Order confirmation #A-4471')).toBe('receipt');
    expect(classifyPaperwork('Payment received — total charged $42.10')).toBe('receipt');
  });

  it('still calls an unpaid invoice a bill, not a receipt', () => {
    // The distinction is the whole point: a bill goes on the to-do list, a
    // receipt goes in the file. Getting it backwards asks a family to pay twice.
    expect(classifyPaperwork('Invoice attached. Amount due: $45.00 by Friday')).toBe('bill_or_payment');
    expect(classifyPaperwork('Balance due for spring tuition')).toBe('bill_or_payment');
  });
});

describe('classifyPaperwork — reservations', () => {
  it('recognises a confirmed booking', () => {
    expect(classifyPaperwork('Your reservation at Bella Trattoria is confirmed')).toBe('reservation');
    expect(classifyPaperwork('Booking reference XJ42Q — check-in date March 12')).toBe('reservation');
    expect(classifyPaperwork('Confirmation number 88213 for your rental')).toBe('reservation');
    expect(classifyPaperwork('Your itinerary is attached')).toBe('reservation');
  });

  it('leaves an invitation as a flyer — an RSVP is not a booking', () => {
    expect(classifyPaperwork("You're invited! RSVP for the spring open house")).toBe('event_flyer');
  });
});

describe('the kinds the column admits', () => {
  it('does not admit the two new kinds, which is why the mapping exists', () => {
    expect(STORED_PAPERWORK_KINDS).not.toContain('receipt');
    expect(STORED_PAPERWORK_KINDS).not.toContain('reservation');
  });

  it('maps a receipt to the payment kind and a reservation to the event kind', () => {
    expect(storedPaperworkKind('receipt')).toBe('bill_or_payment');
    expect(storedPaperworkKind('reservation')).toBe('event_flyer');
  });

  it('leaves every already-admitted kind exactly as it is', () => {
    for (const kind of STORED_PAPERWORK_KINDS) {
      expect(storedPaperworkKind(kind)).toBe(kind);
    }
  });

  it('only ever produces a value the CHECK constraint accepts', () => {
    for (const kind of ALL_KINDS) {
      expect(STORED_PAPERWORK_KINDS).toContain(storedPaperworkKind(kind));
    }
  });

  it('maps EVERY kind — a new one added to triage cannot slip through unmapped', () => {
    // The mapping is a Record<PaperworkKind, …>, so tsc catches a missing entry
    // at compile time; this catches the runtime half — an entry present but set
    // to something the column would reject with a 23514.
    for (const kind of ALL_KINDS) {
      const fields = paperworkKindFields(kind);
      expect(STORED_PAPERWORK_KINDS).toContain(fields.kind);
      expect(fields.meta.triage_kind).toBe(kind);
    }
  });

  it('keeps the finer kind in meta so nothing is lost by the mapping', () => {
    expect(paperworkKindFields('receipt')).toEqual({ kind: 'bill_or_payment', meta: { triage_kind: 'receipt' } });
    expect(paperworkKindFields('reservation')).toEqual({ kind: 'event_flyer', meta: { triage_kind: 'reservation' } });
    expect(paperworkKindFields('sports')).toEqual({ kind: 'sports', meta: { triage_kind: 'sports' } });
  });

  it('labels both new kinds', () => {
    expect(kindLabel('receipt')).toBe('Receipt');
    expect(kindLabel('reservation')).toBe('Reservation');
  });
});

describe('triagePaperwork end to end for the new kinds', () => {
  it('triages a receipt with its amount and leaves nothing due', () => {
    const t = triagePaperwork([
      'Your receipt from Corner Hardware',
      'Thank you for your purchase. Total charged $63.40 to your card.',
    ].join('\n'), NOW);
    expect(t.kind).toBe('receipt');
    expect(t.amount).toBe(63.4);
    expect(t.summary).toContain('Receipt');
  });

  it('triages a reservation with the date it commits the family to', () => {
    const t = triagePaperwork([
      'Reservation confirmed — Bella Trattoria',
      'Table for 4 on March 8 at 7:00pm. Confirmation number 88213.',
    ].join('\n'), NOW);
    expect(t.kind).toBe('reservation');
    expect(t.due_on).toBe('2026-03-08');
    expect(t.urgency).toBe('soon');
    expect(t.summary).toContain('Reservation');
  });
});

describe('the payload every caller inserts', () => {
  // THE BUG THIS PINS: `addPaperworkAction` used to insert `kind: t.kind`
  // straight from `triagePaperwork`. The generated Insert type for `kind` is a
  // plain string, so tsc said nothing, and the day triage learned 'receipt' the
  // paste of a receipt became a 23514 — "Could not save that paperwork", the
  // text gone. The payload has to go through the mapping, and so does every
  // other writer of this table.
  it('never asks the column for a kind it does not admit', async () => {
    const samples: [string, PaperworkKind][] = [
      ['Your receipt from Corner Hardware. Total charged $63.40.', 'receipt'],
      ['Reservation confirmed. Table for 4 on March 8.', 'reservation'],
      ['Invoice attached. Amount due: $45.00 by March 9.', 'bill_or_payment'],
      ['Permission slip: sign and return by March 6.', 'permission_slip'],
      ['hey are you around later', 'other'],
    ];
    for (const [text, expected] of samples) {
      expect(triagePaperwork(text, NOW).kind).toBe(expected);
      const row = await paperworkInsertRow({
        familyId: 'family-1', userId: 'user-1', text, sender: 'Corner Hardware', now: NOW,
      });
      expect(STORED_PAPERWORK_KINDS).toContain(row.kind);
      expect(row.meta.triage_kind).toBe(expected);
    }
  });

  it('files a receipt as a payment and keeps the receipt in meta', async () => {
    const row = await paperworkInsertRow({
      familyId: 'family-1', userId: 'user-1',
      text: 'Your receipt from Corner Hardware. Total charged $63.40.', now: NOW,
    });
    expect(row.kind).toBe('bill_or_payment');
    expect(row.meta).toEqual({ triage_kind: 'receipt' });
    expect(row.amount).toBe(63.4);
    expect(row.family_id).toBe('family-1');
    expect(row.created_by).toBe('user-1');
    expect(row.status).toBe('needs_action');
  });

  it('files a reservation as an event, with the date it commits the family to', async () => {
    const row = await paperworkInsertRow({
      familyId: 'family-1', userId: 'user-1',
      text: 'Reservation confirmed. Table for 4 on March 8.', now: NOW,
    });
    expect(row.kind).toBe('event_flyer');
    expect(row.meta).toEqual({ triage_kind: 'reservation' });
    expect(row.due_on).toBe('2026-03-08');
  });
});
