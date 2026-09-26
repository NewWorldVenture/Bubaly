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
import { at } from './helpers/source-order';

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
  // HOW THIS INVARIANT IS NOW ENFORCED. The original fix was a boolean:
  // `if (filed.inserted && shouldNotifyFamily(...))` around an inline
  // `sendSms(channel.forward_to_phone, ...)`. The parallel session replaced
  // that with a durable urgent-delivery RECEIPT, and the receipt is strictly
  // stronger: `filed.inserted` is a read-then-act race (two concurrent retries
  // can both observe "new" before either files), whereas the receipt CLAIMS the
  // dispatch — a compare-and-set into phase `dispatching` — before it can send.
  // So this guard now pins the receipt path, and additionally pins the ABSENCE
  // of the inline send, because re-adding one would restore the original defect
  // beside a mechanism that looks like it is preventing it.
  it.each(ESCALATING_WEBHOOKS)('%s escalates only through the urgent-delivery receipt', (path) => {
    const src = read(path);
    expect(
      /sendSms\(channel[?.]*\.forward_to_phone/.test(src),
      `${path} escalates inline again; a Twilio retry alarms the family twice`,
    ).toBe(false);
    expect(src, `${path} no longer escalates at all; update this list`).toContain('attemptUrgentDelivery(');
    // The receipt id comes from the de-duplicating intake, so a replay reaches
    // the SAME receipt rather than opening a second escalation.
    expect(src).toContain('captureInboundWithUrgency(');
    expect(src).toMatch(/filed\.urgentReceiptId\s*\?\s*await attemptUrgentDelivery\(/);
  });

  it.each(ESCALATING_WEBHOOKS)('%s writes no urgent notification of its own', (path) => {
    const src = read(path);
    // The notification row and the SMS are the same event, and both now belong
    // to the receipt (`ensureNotification`). A direct insert here would ring the
    // family's bell on every retry even while the SMS stayed correctly claimed.
    expect(
      /from\('notifications'\)\.insert\(/.test(src),
      `${path} inserts an urgent notification outside the receipt`,
    ).toBe(false);
  });

  it('the receipt only dispatches from a claimed queue slot', () => {
    // This is where the idempotency actually lives now, so it is asserted here
    // rather than taken on trust from the routes above.
    const src = read('lib/contact-center/urgent-delivery.ts');
    // Anything already dispatching is never re-sent.
    expect(src).toContain("if (receipt.outputs.phase === 'dispatching')");
    // Only a queued receipt proceeds; every other phase returns before the send.
    expect(src).toContain("if (receipt.outputs.phase !== 'queued')");
    // And the claim is a transition, taken BEFORE the provider call.
    const claimAt = at(src, "phase: 'dispatching'");
    expect(claimAt).toBeLessThan(at(src, 'await sendSmsWithReceipt('));
    expect(src).toContain('if (!claimed) return');
  });

  it.each(CLAIMING_WEBHOOKS)('%s still claims its callback before acting', (path) => {
    // The other half of the rule, pinned so the guardian routes cannot quietly
    // lose it: these have no filed-once intake to fall back on. The voicemail
    // route claims through its own `claimGuardianVoicemail`, and the signed SMS
    // route through the leased `receiveGuardianSms` processor; both are claims.
    expect(read(path)).toMatch(/claimGuardianCallback\(|claimGuardianVoicemail\(|receiveGuardianSms\(/);
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
