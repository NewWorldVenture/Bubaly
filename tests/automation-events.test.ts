import { describe, it, expect } from 'vitest';
import {
  EVENT_TRIGGERS, EVENT_DEFAULT_COPY, isEventTrigger, eventSubjectKey,
} from '@/lib/marketing/automation-triggers';

describe('isEventTrigger', () => {
  it('recognizes event-driven triggers', () => {
    expect(isEventTrigger('form_submitted')).toBe(true);
    expect(isEventTrigger('email_opened')).toBe(true);
    expect(isEventTrigger('email_clicked')).toBe(true);
    expect(isEventTrigger('payment_completed')).toBe(true);
  });
  it('rejects scheduled / unknown triggers', () => {
    expect(isEventTrigger('customer_inactive')).toBe(false);
    expect(isEventTrigger('high_value_detected')).toBe(false);
    expect(isEventTrigger('nonsense')).toBe(false);
  });
});

describe('EVENT_DEFAULT_COPY', () => {
  it('has copy for every event trigger', () => {
    for (const t of EVENT_TRIGGERS) {
      expect(EVENT_DEFAULT_COPY[t].subject.length).toBeGreaterThan(0);
      expect(EVENT_DEFAULT_COPY[t].body.length).toBeGreaterThan(0);
    }
  });
});

describe('eventSubjectKey', () => {
  it('namespaces by trigger and joins parts (lowercased)', () => {
    expect(eventSubjectKey('form_submitted', ['WEB-123'])).toBe('form_submitted:web-123');
    expect(eventSubjectKey('email_opened', ['camp-1', 'a@B.com'])).toBe('email_opened:camp-1:a@b.com');
  });
  it('is stable for the same inputs (so redeliveries dedup)', () => {
    const a = eventSubjectKey('payment_completed', ['sess_1']);
    const b = eventSubjectKey('payment_completed', ['sess_1']);
    expect(a).toBe(b);
  });
  it('drops empty/nullish parts but stays non-empty', () => {
    expect(eventSubjectKey('email_clicked', [null, undefined, ''])).toBe('email_clicked:anon');
    expect(eventSubjectKey('email_clicked', ['', 'x'])).toBe('email_clicked:x');
  });
});
