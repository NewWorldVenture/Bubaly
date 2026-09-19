// A Twilio callback that arrives twice must not tell the family twice.
//
// The repository knows the rule and wrote it down. `lib/guardian/callbacks.ts`
// exists to make these callbacks idempotent and explains why in its own header
// ("Twilio does not retry a 200"), and all four guardian webhooks claim their
// callback before doing any work. The four Contact Center webhooks do not claim
// at all — they de-duplicate the inbound ROW instead, through
// `recordInboundMessage`, which returns `inserted: false` for a delivery it has
// already seen.
//
// That is a sound alternative, and two of the three routes with an escalation
// used it for only ONE of their side effects. The comments prove the authors
// knew: voice/transcription says in as many words
//
//     Twilio retries a transcription callback, so only a delivery that was
//     actually new reaches the planner
//
// and then sends the urgent SMS three lines later, outside that guard. The sms
// route does the same. `email` gets it right, in the same feature, with the
// same helper — so this is not a rule nobody knew, it is a guard applied to the
// new code (M20's planner) and not to the escalation already sitting beside it.
//
// The window is not narrow. The concierge's model call is allowed 60 seconds
// (OPENAI_TIMEOUT_MS) on routes that set no maxDuration, which is longer than
// any webhook timeout, so a retry arriving while the first attempt is still
// running is ordinary rather than exotic. A duplicated "🚨 Urgent at your
// Bubaly line" reads to a family as a second emergency. Audit C1-S7-04.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Contact Center webhooks that escalate to a human's real phone. */
const ESCALATING_WEBHOOKS = [
  'app/api/contact-center/sms/route.ts',
  'app/api/contact-center/email/route.ts',
  'app/api/contact-center/voice/transcription/route.ts',
];

/** Every Twilio webhook that claims its callback before acting. */
const CLAIMING_WEBHOOKS = [
  'app/api/guardian/inbound/sms/route.ts',
  'app/api/guardian/inbound/voice/route.ts',
  'app/api/guardian/inbound/whatsapp/route.ts',
  'app/api/guardian/status/voicemail/route.ts',
];

describe('a retried webhook does not alarm the family twice (C1-S7-04)', () => {
  it.each(ESCALATING_WEBHOOKS)('%s gates its escalation on a NEW delivery', (path) => {
    const src = read(path);
    // The escalation must be reached only when this delivery was not already
    // filed. Matching the guard on the same condition as the send, rather than
    // "the file mentions filed.inserted somewhere", is the point: every one of
    // these files already mentioned it — for the planner.
    const sends = /sendSms\(channel\.forward_to_phone/.test(src);
    expect(sends, `${path} no longer escalates; update this list`).toBe(true);
    expect(
      /if \(filed\.inserted && shouldNotifyFamily\(/.test(src),
      `${path} sends an urgent SMS without checking the delivery was new — a Twilio retry alarms the family again`,
    ).toBe(true);
  });

  it.each(ESCALATING_WEBHOOKS)('%s writes its urgent notification under the same guard', (path) => {
    const src = read(path);
    // The notification row and the SMS are the same event. If the insert drifts
    // outside the guard the family's bell rings twice even when the SMS does not.
    const guardAt = src.indexOf('if (filed.inserted && shouldNotifyFamily(');
    const insertAt = src.indexOf("from('notifications').insert(");
    if (insertAt === -1) return; // email notifies by its own path
    expect(guardAt, `${path} lost its escalation guard`).toBeGreaterThan(-1);
    expect(insertAt, `${path} inserts the urgent notification outside the new-delivery guard`).toBeGreaterThan(guardAt);
  });

  it.each(CLAIMING_WEBHOOKS)('%s still claims its callback before acting', (path) => {
    // The other half of the rule, pinned so the guardian routes cannot quietly
    // lose it: these have no `filed.inserted` to fall back on.
    expect(read(path)).toMatch(/claimGuardianCallback\(/);
  });

  it('the de-duplicating read still reports whether it inserted', () => {
    // The whole approach rests on this one bit. A refactor that made
    // recordInboundMessage return void would make every guard above vacuous
    // while leaving them all green.
    const src = read('lib/contact-center/server.ts');
    expect(src).toMatch(/inserted:\s*false/);
    expect(src).toMatch(/inserted:\s*true/);
  });
});
