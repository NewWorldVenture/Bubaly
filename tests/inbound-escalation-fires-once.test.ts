import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Three sibling routes file an inbound message, then escalate a genuine urgency
// to the family's human fallback number with a 🚨 SMS and a notification row.
// All three call `recordInboundMessage`, which answers `inserted: false` when the
// provider has re-fired a delivery it already sent.
//
// The EMAIL route gated its escalation on that flag. The SMS and voicemail
// routes gated only the planner routing — and wrote the reasoning down while
// doing it ("Twilio retries a transcription callback, so only a delivery that
// was actually new reaches the planner") — while the two side effects that
// actually reach a person ran on every redelivery. One message, two 🚨 texts.
//
// Asserted against the route sources because the alternative proves a mock: the
// behaviour is "Twilio sent this twice", and the flag that encodes it is already
// computed inside `recordInboundMessage`.

const ROUTES = [
  'app/api/contact-center/sms/route.ts',
  'app/api/contact-center/voice/transcription/route.ts',
  'app/api/contact-center/email/route.ts',
];

describe('an inbound escalation fires once per message, not once per delivery', () => {
  it.each(ROUTES)('%s gates its urgent escalation on a NEW delivery', (route) => {
    const source = readFileSync(route, 'utf8');

    // The route must actually have the two things this is about.
    expect(source).toContain('recordInboundMessage(');
    expect(source).toContain('shouldNotifyFamily(');

    // Scoped to the condition itself. A bare `toContain('filed.inserted')` would
    // pass on the planner-routing check alone, which is exactly the state these
    // two routes were already in.
    const condition = source.match(/if \([^)]*shouldNotifyFamily\(result\.intent\)[^)]*\) \{/);
    expect(condition, `${route}: the escalation condition was not found`).not.toBeNull();
    expect(condition?.[0]).toContain('filed.inserted');
  });

  it.each(ROUTES)('%s sends the urgent SMS inside that condition, not beside it', (route) => {
    const source = readFileSync(route, 'utf8');
    const start = source.search(/if \([^)]*shouldNotifyFamily\(result\.intent\)[^)]*\) \{/);
    const block = source.slice(start, source.indexOf('\n  }', start));
    expect(block).toContain('sendSms(channel.forward_to_phone');
  });

  it('files the urgent notification inside that condition on the two routes that write one', () => {
    // The email route escalates by SMS only and writes no notification row, so
    // asserting one for all three would fail on a route that is already correct.
    for (const route of [
      'app/api/contact-center/sms/route.ts',
      'app/api/contact-center/voice/transcription/route.ts',
    ]) {
      const source = readFileSync(route, 'utf8');
      const start = source.search(/if \([^)]*shouldNotifyFamily\(result\.intent\)[^)]*\) \{/);
      const block = source.slice(start, source.indexOf('\n  }', start));
      expect(block, route).toContain("from('notifications').insert(");
    }
  });
});
