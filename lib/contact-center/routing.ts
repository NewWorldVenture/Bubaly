// The AI concierge's deterministic first pass: classify an inbound message
// (call transcript / SMS / email) by intent, decide how to route it, and produce
// a short summary. Pure + client-safe + tested (tests/contact-center-routing.test.ts).
// The AI provider layers richer summaries on top of this in the webhook path;
// this guarantees a sensible answer even when AI is unconfigured.

import { frontDeskDomain } from '@/lib/front-desk/school-sports';

export type InboundChannel = 'email' | 'sms' | 'voice';

export type InboundIntent =
  | 'urgent' | 'appointment' | 'delivery' | 'sales' | 'spam' | 'personal'
  | 'school' | 'sports'
  | 'other';

export type RouteAction = 'escalate' | 'auto_reply' | 'file';

const INTENT_META: Record<InboundIntent, { label: string; tone: string; emoji: string }> = {
  urgent:      { label: 'Urgent',       tone: 'text-rose-500',    emoji: '🚨' },
  appointment: { label: 'Appointment',  tone: 'text-blue-500',    emoji: '📅' },
  delivery:    { label: 'Delivery',     tone: 'text-amber-500',   emoji: '📦' },
  sales:       { label: 'Sales pitch',  tone: 'text-muted',       emoji: '🏷️' },
  spam:        { label: 'Spam',         tone: 'text-muted',       emoji: '🚫' },
  personal:    { label: 'Personal',     tone: 'text-emerald-500', emoji: '💬' },
  school:      { label: 'School',       tone: 'text-violet-500',  emoji: '🎒' },
  sports:      { label: 'Sports',       tone: 'text-cyan-500',    emoji: '⚽' },
  other:       { label: 'General',      tone: 'text-brand-text',  emoji: '✉️' },
};

export function intentMeta(intent: string): { label: string; tone: string; emoji: string } {
  return (INTENT_META as Record<string, { label: string; tone: string; emoji: string }>)[intent] ?? INTENT_META.other;
}

/**
 * Urgent outranks everything, including the front desk.
 *
 * Pulled out of `RULES` so the school/sports pass can sit between it and the
 * rest: a school calling to say a child is hurt escalates to a human, and does
 * not go and sit in a desk queue waiting for someone to press Propose. It is
 * still the first thing tested, exactly as it was when it led that list.
 */
const URGENT = /\b(emergency|urgent|asap|right away|hospital|accident|911|locked out|flooding|leak|help me)\b/i;

// Ordered strongest-signal-first: the first bucket that matches wins.
const RULES: { intent: InboundIntent; re: RegExp }[] = [
  { intent: 'appointment', re: /\b(appointment|reschedul|confirm|booking|reservation|dentist|doctor|pick ?up|drop ?off|meeting at|see you (at|on))\b/i },
  { intent: 'delivery',    re: /\b(deliver|package|parcel|shipment|out for delivery|courier|fedex|ups|usps|amazon|dropped off|left at)\b/i },
  { intent: 'sales',       re: /\b(offer|discount|limited time|warranty|free quote|special deal|upgrade your|save \$|promo(tion)?)\b/i },
  { intent: 'spam',        re: /\b(you(?:'| ha)ve won|claim your prize|gift card|crypto|wire transfer|social security|irs|final notice|click this link|verify your account)\b/i },
];

/**
 * Classify inbound text into a single best-fit intent.
 *
 * School and sports are tested BEFORE appointment/delivery/sales because those
 * buckets swallowed them: "the parent-teacher conference has been rescheduled"
 * is an `appointment` by keyword and a school schedule change in fact, and the
 * generic bucket is what left every school mail filed with nothing anyone could
 * act on. `frontDeskDomain` only fires on a real school or sports signal, so a
 * dentist appointment is untouched.
 */
export function classifyIntent(text: string | null | undefined): InboundIntent {
  const t = (text ?? '').trim();
  if (!t) return 'other';
  if (URGENT.test(t)) return 'urgent';
  const desk = frontDeskDomain(t);
  if (desk) return desk;
  for (const { intent, re } of RULES) if (re.test(t)) return intent;
  return 'personal';
}

/** How the concierge should route a message of a given intent. */
export function routeInbound(intent: InboundIntent): RouteAction {
  if (intent === 'urgent') return 'escalate';
  if (intent === 'spam') return 'file';
  if (intent === 'sales') return 'auto_reply';
  return 'auto_reply';
}

/**
 * Whether an inbound message is household work the planner should see.
 *
 * Appointments, deliveries and personal messages are things a family has to do
 * something about; sales, spam and 'other' are not, and filing them would fill
 * the run ledger with noise nobody asked for. Urgent is deliberately absent:
 * it escalates to a human immediately (`shouldNotifyFamily`), and a run started
 * behind that escalation would race the person it just woke.
 */
export function shouldPlanInbound(intent: string): boolean {
  return intent === 'appointment' || intent === 'delivery' || intent === 'personal'
    // School and sports mail is household work by definition — a form to sign,
    // a fee to pay, a practice that moved. It reaches the planner on the same
    // terms as the rest: a filed request, gated, with anything risky waiting
    // for a parent. Nothing here executes.
    || intent === 'school' || intent === 'sports';
}

/** Whether the family should be pinged now (urgent → yes; the rest wait in the inbox). */
export function shouldNotifyFamily(intent: InboundIntent): boolean {
  return routeInbound(intent) === 'escalate';
}

/** A short, single-line summary for the inbox row (deterministic fallback). */
export function summarizeInbound(text: string | null | undefined, max = 140): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'No message content.';
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** A courteous concierge auto-reply appropriate to the intent (SMS/email). */
export function autoReplyText(intent: InboundIntent, familyLabel = 'the family'): string {
  switch (intent) {
    case 'urgent':
      return `Thanks for reaching ${familyLabel}. This looks urgent — I’m notifying them right now and someone will get back to you shortly.`;
    case 'appointment':
      return `Thanks! I’ve logged this appointment note for ${familyLabel} and flagged it for them to confirm.`;
    case 'delivery':
      return `Got it — I’ve recorded this delivery update for ${familyLabel}.`;
    case 'sales':
      return `Thanks for the offer. ${familyLabel} isn’t taking sales calls at this number, but I’ve noted it.`;
    case 'school':
      return `Thanks — I’ve logged this school notice for ${familyLabel} and put it in front of them.`;
    case 'sports':
      return `Thanks — I’ve logged this club message for ${familyLabel} and put it in front of them.`;
    case 'spam':
      return `This message has been filed.`;
    default:
      return `Thanks for contacting ${familyLabel}. I’ve passed your message along and someone will follow up.`;
  }
}
