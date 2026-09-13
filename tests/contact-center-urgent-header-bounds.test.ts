import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_ADDRESS, MAX_BODY, MAX_PROVIDER_REF, MAX_SUBJECT, MAX_SUMMARY,
} from '@/lib/contact-center/urgent-delivery';

// An urgent inbound email was PERMANENTLY lost when one of its headers was
// long. The receipt schema caps `to`/`from` at 512, `subject` at 1000 and
// `providerRef` at 2048; the route took all four straight from the request and
// sliced only the body. The resulting ZodError is thrown before anything is
// written and is not caught inside captureInboundWithUrgency, so it reached the
// route's `catch` and answered 503 — no inbox row, no escalation, no
// notification, no auto-reply. Deterministic, so every provider redelivery
// failed identically.
//
// And it landed exactly where it hurts: the non-urgent path short-circuits
// before the parse, so the SAME headers file fine when the message is routine.
// Only the messages this subsystem exists to escalate were dropped.

const route = readFileSync('app/api/contact-center/email/route.ts', 'utf8');

describe('the caps a receipt enforces are the caps its callers bound to', () => {
  it('publishes them, rather than leaving each caller to guess', () => {
    // Two places holding the same limits privately is how they drifted.
    expect([MAX_ADDRESS, MAX_SUBJECT, MAX_PROVIDER_REF, MAX_BODY, MAX_SUMMARY])
      .toEqual([512, 1000, 2048, 8000, 1000]);
  });

  it('bounds every field the email route takes from the request', () => {
    for (const [field, cap] of [
      ["pick(fields, 'to', 'To', 'recipient', 'envelope_to')", 'MAX_ADDRESS'],
      ["pick(fields, 'from', 'From', 'sender')", 'MAX_ADDRESS'],
      ["pick(fields, 'subject', 'Subject')", 'MAX_SUBJECT'],
      ["pick(fields, 'Message-Id', 'message-id', 'messageId')", 'MAX_PROVIDER_REF'],
    ] as const) {
      expect(route, `${field} must be bounded`).toContain(`${field}.slice(0, ${cap})`);
    }
  });

  it('bounds the body to the FIELD cap, not the request cap', () => {
    // This file has its own MAX_BODY — 1 MB, for the whole request. Importing
    // the receipt's MAX_BODY unaliased silently swapped an 8 KB field cap for a
    // 1 MB one, which is the same defect wearing a different hat.
    expect(route).toContain('MAX_BODY as MAX_RECEIPT_BODY');
    expect(route).toContain('.slice(0, MAX_RECEIPT_BODY)');
    expect(route).toMatch(/const MAX_BODY = 1024 \* 1024/);
  });

  it('leaves nothing unbounded on the way to the receipt', () => {
    // The property, rather than the four spellings above: every `pick(...)`
    // whose result reaches a receipt field is followed by a slice.
    const unbounded = [...route.matchAll(/const (to|from|subject|messageId|body) = [^;]+;/g)]
      .filter((match) => !match[0].includes('.slice('))
      .map((match) => match[1]);
    expect(unbounded, 'these reach inputSchema.parse unbounded').toEqual([]);
  });
});
