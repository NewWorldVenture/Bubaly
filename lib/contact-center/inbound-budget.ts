// Budgets for the Twilio-delivered lanes of the Contact Center: how many times
// a day the concierge (one model call per message) may run for an inbound text
// or voicemail, and how many automatic SMS replies may go out. The inbound-email
// lane has the same two budgets, defined beside its own rules in
// lib/contact-center/inbound-mail.ts (audit N1); these are the sibling path that
// finding did not cover (RV1-N1-sibling-sms-voice).
//
// WHY. app/api/contact-center/sms/route.ts and voice/transcription/route.ts ran
// `runConcierge` for every message Twilio delivered, and the only budget
// anywhere on those paths was the urgent SMS lane's
// (lib/contact-center/urgent-delivery.ts). The threat model is weaker than
// email's — the request is Twilio-signed, the sender pays per text or call, and
// the reply goes to the verified sender number rather than to an address the
// sender wrote — so the amplification is roughly 1:1 rather than unbounded
// backscatter. It is still one model call per message from anyone who knows
// the family's number, and the SMS auto-reply was deduplicated per Twilio SID
// only, so a loop between two auto-responders had nothing to stop it.
//
// SHAPE. Per sender (the signed E.164 `From`) and per family number, over a
// day, the narrower budget charged first so a sender over its own budget does
// not spend the family's. Fail-closed like every durable limiter here: a
// limiter that cannot be read withholds the concierge and the reply, and the
// message is still filed with the deterministic classification
// (`withheldConcierge`). The per-sender key carries a phone number, which the
// durable limiter stores as a keyed digest, never as the number
// (lib/server/rate-limit-db.ts).
//
// On the SERVICE client, always: these keys name a family and a stranger's
// number, not a signed-in caller, and rate_limit_hit (0179) refuses such a key
// from a session (a-signed-in-rate-limit-key-names-the-caller).
import { createServiceClient } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { DAY_MS } from './inbound-mail';

/**
 * Concierge runs one family number may draw in a day across every sender, and
 * the same for one sender at one family: a cost ceiling, not a quota a
 * household is expected to reach. The same figures as the email lane.
 */
export const SMS_CONCIERGE_PER_FAMILY_PER_DAY = 200;
export const SMS_CONCIERGE_PER_SENDER_PER_DAY = 40;
export const VOICE_CONCIERGE_PER_FAMILY_PER_DAY = 200;
export const VOICE_CONCIERGE_PER_SENDER_PER_DAY = 40;
/**
 * Automatic SMS replies one family number may send in a day, and how many one
 * sender may draw. Not one — a neighbour who texts twice is answered twice —
 * but small enough that an auto-responder on the other end (another family's
 * Contact Center number among them) cannot keep a loop going.
 */
export const SMS_REPLY_PER_FAMILY_PER_DAY = 50;
export const SMS_REPLY_PER_SENDER_PER_DAY = 5;

/** The route's own test for a number a reply could go back to. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** The sender a per-sender budget is keyed on: a signed E.164 `From`, or nobody. */
export function budgetedSender(from: string | null | undefined): string | null {
  return from && E164.test(from) ? from : null;
}

const CONCIERGE_LIMITS = {
  sms: { sender: SMS_CONCIERGE_PER_SENDER_PER_DAY, family: SMS_CONCIERGE_PER_FAMILY_PER_DAY },
  voice: { sender: VOICE_CONCIERGE_PER_SENDER_PER_DAY, family: VOICE_CONCIERGE_PER_FAMILY_PER_DAY },
} as const;

/**
 * Whether this message may run the concierge (one model call): per sender
 * number when `From` is one, then per family, over a day. Unreadable means
 * withheld.
 */
export async function conciergeBudgetAllows(lane: 'sms' | 'voice', familyId: string, from: string | null | undefined): Promise<boolean> {
  const supabase = createServiceClient();
  const limits = CONCIERGE_LIMITS[lane];
  const sender = budgetedSender(from);
  if (sender) {
    const perSender = await enforceRequestRateLimit(supabase, `cc-${lane}:sender:${familyId}:${sender}`, { limit: limits.sender, windowMs: DAY_MS });
    if (!perSender.ok) return false;
  }
  const perFamily = await enforceRequestRateLimit(supabase, `cc-${lane}:family:${familyId}`, { limit: limits.family, windowMs: DAY_MS });
  return perFamily.ok;
}

/** Whether one more automatic SMS reply may go to this number from this family today. */
export async function smsReplyBudgetAllows(familyId: string, to: string | null | undefined): Promise<boolean> {
  const supabase = createServiceClient();
  const sender = budgetedSender(to);
  if (sender) {
    const perSender = await enforceRequestRateLimit(supabase, `cc-sms-reply:${familyId}:${sender}`, { limit: SMS_REPLY_PER_SENDER_PER_DAY, windowMs: DAY_MS });
    if (!perSender.ok) return false;
  }
  const perFamily = await enforceRequestRateLimit(supabase, `cc-sms-reply:${familyId}`, { limit: SMS_REPLY_PER_FAMILY_PER_DAY, windowMs: DAY_MS });
  return perFamily.ok;
}
