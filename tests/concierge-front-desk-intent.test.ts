// The one line of the concierge S-06 had to change, and why it is safe.
//
// The concierge's SYSTEM prompt never offers the model 'school' or 'sports', so
// the best it can say about a permission slip is 'other'. Taking that at face
// value discarded the deterministic front-desk verdict — and since all three
// webhooks (email, sms, voice) pass the concierge's intent to
// recordInboundMessage, the school/sports routing would have been dead on
// arrival: nothing would ever be filed as school work.
//
// `preferFrontDesk` is deliberately the narrowest possible override: it defers
// to the deterministic answer ONLY when the model reached for the generic
// bucket AND that answer is one of the two the model was never offered. Every
// other model answer still wins, unchanged. This file exists because nothing
// covered runConcierge before, and a behavioural change in a shared file with
// no test is how a silent regression gets in.
import { describe, expect, it } from 'vitest';
import { preferFrontDesk } from '@/lib/contact-center/concierge';
import type { InboundIntent } from '@/lib/contact-center/routing';

describe('preferFrontDesk', () => {
  it('lets the desk verdict through only when the model said "other"', () => {
    expect(preferFrontDesk('other', 'school')).toBe('school');
    expect(preferFrontDesk('other', 'sports')).toBe('sports');
  });

  it('never overrides an answer the model actually made', () => {
    for (const modelIntent of ['urgent', 'sales', 'spam', 'appointment', 'billing'] as InboundIntent[]) {
      expect(preferFrontDesk(modelIntent, 'school')).toBe(modelIntent);
      expect(preferFrontDesk(modelIntent, 'sports')).toBe(modelIntent);
    }
  });

  it('leaves "other" alone when the desk did not recognise it either', () => {
    // The override is not a general "fallback wins" rule: only the two intents
    // the model is structurally unable to return are allowed to come back.
    for (const fallback of ['other', 'urgent', 'spam', 'sales'] as InboundIntent[]) {
      expect(preferFrontDesk('other', fallback)).toBe('other');
    }
  });
});
