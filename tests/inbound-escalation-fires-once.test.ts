import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Three sibling routes file an inbound message, then escalate a genuine urgency
// to the family's human fallback number with a 🚨 SMS and a notification row.
//
// The original defect: all three called `recordInboundMessage`, which answers
// `inserted: false` when the provider re-fired a delivery it already sent. The
// EMAIL route gated its escalation on that flag. The SMS and voicemail routes
// gated only the planner routing — and wrote the reasoning down while doing it
// ("Twilio retries a transcription callback, so only a delivery that was
// actually new reaches the planner") — while the two side effects that actually
// reach a person ran on every redelivery. One message, two 🚨 texts.
//
// What the routes do now is STRONGER than the `filed.inserted &&` this file
// originally pinned, and the difference is worth stating because it is the
// reason these assertions changed shape rather than being relaxed.
// `filed.inserted` only covers a redelivery that finds the row already there. It
// says nothing about a crash BETWEEN the insert and the SMS: the next delivery
// then sees `inserted: false` and skips an escalation that never happened, which
// is the same flag failing in the opposite direction. A durable receipt answers
// both — `captureInboundWithUrgency` mints one keyed on the provider ref, and
// `attemptUrgentDelivery` advances it through a CAS transition, so exactly one
// caller reaches the send and an interrupted one resumes.
//
// Asserted against the sources because the alternative proves a mock: the
// behaviour is "Twilio sent this twice", and what encodes it is a stored row.

const ROUTES = [
  'app/api/contact-center/sms/route.ts',
  'app/api/contact-center/voice/transcription/route.ts',
  'app/api/contact-center/email/route.ts',
];

const DELIVERY = 'lib/contact-center/urgent-delivery.ts';

/** Line-preserving comment strip, so prose cannot stand in for control flow. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('an inbound escalation fires once per message, not once per delivery', () => {
  it.each(ROUTES)('%s escalates only through a receipt it was handed', (route) => {
    const code = withoutComments(readFileSync(route, 'utf8'));
    expect(code).toContain('captureInboundWithUrgency(');
    // The receipt id is the ONLY thing that authorises an escalation, and it is
    // absent unless the capture minted one — which it does only for an urgent
    // intent. That replaces the route-level `shouldNotifyFamily(...)` check.
    expect(code).toMatch(/filed\.urgentReceiptId\s*\?\s*await attemptUrgentDelivery\(admin, filed\.urgentReceiptId, familyId\)/);
  });

  it.each(ROUTES)('%s sends no urgent SMS of its own', (route) => {
    const code = withoutComments(readFileSync(route, 'utf8'));
    // The regression this file exists for was a bare `sendSms(...)` beside the
    // condition rather than inside it. With the receipt, a route that sends at
    // all has re-introduced exactly that: an escalation nothing can deduplicate.
    expect(code, `${route} sends an urgent SMS outside the receipt path`)
      .not.toMatch(/sendSms\(channel[?.]*\.forward_to_phone/);
    expect(code, `${route} writes an urgent notification outside the receipt path`)
      .not.toMatch(/from\('notifications'\)\.insert\([^)]*urgent/i);
  });

  it('only a queued receipt reaches the send, and it claims before sending', () => {
    const code = withoutComments(readFileSync(DELIVERY, 'utf8'));
    const body = code.slice(code.indexOf('export async function attemptUrgentDelivery'));
    // Anything already past `queued` returns its stored phase instead of sending,
    // which is what makes a re-fired webhook a no-op.
    expect(body).toMatch(/if \(receipt\.outputs\.phase !== 'queued'\)/);
    expect(body).toMatch(/if \(receipt\.outputs\.phase === 'dispatching'\)/);
    // And the transition to `dispatching` is compare-and-set: a lost race returns
    // 'pending' rather than sending a second text.
    const claim = body.slice(body.indexOf("phase: 'dispatching'"));
    expect(claim).toMatch(/if \(!claimed\) return 'pending';/);
    expect(claim.indexOf('sendSmsWithReceipt('), 'the send must follow the claim')
      .toBeGreaterThan(claim.indexOf("if (!claimed) return 'pending';"));
  });

  it('the notification row is written once, tracked on the receipt', () => {
    const code = withoutComments(readFileSync(DELIVERY, 'utf8'));
    const body = code.slice(code.indexOf('export async function attemptUrgentDelivery'));
    expect(body).toMatch(/let notificationDone = receipt\.outputs\.notificationDone;/);
    expect(body).toMatch(/if \(!notificationDone\) \{/);
    expect(body).toContain('ensureNotification(admin, receipt');
  });

  it('the receipt is keyed on the provider reference, not on the row it files', () => {
    // A key derived from the inserted row could not exist before the insert, so
    // a crash between the two would mint a second receipt — the original bug.
    const code = withoutComments(readFileSync(DELIVERY, 'utf8'));
    const capture = code.slice(code.indexOf('export async function captureInboundWithUrgency'));
    expect(capture).toMatch(/const providerRef = inboundProviderRef\(input\), expected = identity\(\{ \.\.\.input, providerRef \}\)/);
    // Non-urgent intents never mint one at all, which is where the old
    // `shouldNotifyFamily(result.intent)` condition went.
    expect(capture).toMatch(/if \(!receipt && input\.aiIntent !== 'urgent'\) return recordInboundMessage\(/);
    // A duplicate insert is expected and tolerated; anything else is not.
    expect(capture).toMatch(/saved\.error\.code !== '23505'/);
  });
});
