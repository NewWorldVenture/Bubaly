// The AI concierge's deterministic first pass: classify an inbound message
// (call transcript / SMS / email) by intent, decide how to route it, and produce
// a short summary. Pure + client-safe + tested (tests/contact-center-routing.test.ts).
// The AI provider layers richer summaries on top of this in the webhook path;
// this guarantees a sensible answer even when AI is unconfigured.

export type InboundChannel = 'email' | 'sms' | 'voice';

export type InboundIntent =
  | 'urgent' | 'appointment' | 'delivery' | 'sales' | 'spam' | 'personal' | 'other';

export type RouteAction = 'escalate' | 'auto_reply' | 'file';

const INTENT_META: Record<InboundIntent, { label: string; tone: string; emoji: string }> = {
  urgent:      { label: 'Urgent',       tone: 'text-rose-500',    emoji: '🚨' },
  appointment: { label: 'Appointment',  tone: 'text-blue-500',    emoji: '📅' },
  delivery:    { label: 'Delivery',     tone: 'text-amber-500',   emoji: '📦' },
  sales:       { label: 'Sales pitch',  tone: 'text-muted',       emoji: '🏷️' },
  spam:        { label: 'Spam',         tone: 'text-muted',       emoji: '🚫' },
  personal:    { label: 'Personal',     tone: 'text-emerald-500', emoji: '💬' },
  other:       { label: 'General',      tone: 'text-brand-text',  emoji: '✉️' },
};

export function intentMeta(intent: string): { label: string; tone: string; emoji: string } {
  return (INTENT_META as Record<string, { label: string; tone: string; emoji: string }>)[intent] ?? INTENT_META.other;
}

// Ordered strongest-signal-first: the first bucket that matches wins.
const RULES: { intent: InboundIntent; re: RegExp }[] = [
  { intent: 'urgent',      re: /\b(emergency|urgent|asap|right away|hospital|accident|911|locked out|flooding|leak|help me)\b/i },
  { intent: 'appointment', re: /\b(appointment|reschedul|confirm|booking|reservation|dentist|doctor|pick ?up|drop ?off|meeting at|see you (at|on))\b/i },
  { intent: 'delivery',    re: /\b(deliver|package|parcel|shipment|out for delivery|courier|fedex|ups|usps|amazon|dropped off|left at)\b/i },
  { intent: 'sales',       re: /\b(offer|discount|limited time|warranty|free quote|special deal|upgrade your|save \$|promo(tion)?)\b/i },
  { intent: 'spam',        re: /\b(you(?:'| ha)ve won|claim your prize|gift card|crypto|wire transfer|social security|irs|final notice|click this link|verify your account)\b/i },
];

/** Classify inbound text into a single best-fit intent. */
export function classifyIntent(text: string | null | undefined): InboundIntent {
  const t = (text ?? '').trim();
  if (!t) return 'other';
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
  return intent === 'appointment' || intent === 'delivery' || intent === 'personal';
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
    case 'spam':
      return `This message has been filed.`;
    default:
      return `Thanks for contacting ${familyLabel}. I’ve passed your message along and someone will follow up.`;
  }
}
