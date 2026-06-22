// lib/marketing/automation-triggers.ts — pure, no server-only.
// Event-driven automation triggers fire in real time from app events (a contact
// form submit, an email open/click, a completed checkout) rather than from the
// scheduled cron sweep. This module holds the trigger registry, default email
// copy, and the dedup subject-key builder so they can be unit-tested in isolation.

export const EVENT_TRIGGERS = [
  'form_submitted',
  'email_opened',
  'email_clicked',
  'payment_completed',
  'checkout_abandoned',
  'onboarding_completed',
] as const;
export type EventTrigger = (typeof EVENT_TRIGGERS)[number];

export function isEventTrigger(trigger: string): trigger is EventTrigger {
  return (EVENT_TRIGGERS as readonly string[]).includes(trigger);
}

export type Copy = { subject: string; body: string };

/** Fallback email copy when a workflow's send_email step omits its own. */
export const EVENT_DEFAULT_COPY: Record<EventTrigger, Copy> = {
  form_submitted: {
    subject: 'Thanks for reaching out to Bubaly',
    body: "We got your message and a real person will reply shortly. In the meantime, here's a quick tour of what Bubaly can do for your family.",
  },
  email_opened: {
    subject: 'Glad that caught your eye 👀',
    body: 'Since you opened our last note, here are the three Bubaly features families love most — set up in under two minutes.',
  },
  email_clicked: {
    subject: 'Picking up where you left off',
    body: 'Thanks for clicking through! Ready to finish setting up? Your family calendar and shared lists are waiting.',
  },
  payment_completed: {
    subject: 'Welcome to your upgraded Bubaly plan 🎉',
    body: "Your payment went through — your whole family now has everything unlocked. Here's how to get the most out of it.",
  },
  checkout_abandoned: {
    subject: 'Still thinking it over? Your Bubaly plan is waiting',
    body: 'You were a step away from upgrading your family plan. Pick up right where you left off — it only takes a minute, and you can cancel anytime.',
  },
  onboarding_completed: {
    subject: 'Welcome to Bubaly — your family HQ is ready 🎉',
    body: "Your family is all set up! Here's how to get the most out of Bubaly in the first week: add your calendar, set up chores, and invite everyone in.",
  },
};

/**
 * Deterministic dedup key for an event occurrence. Combined with a unique
 * (workflow_id, subject_key) index, this guarantees a workflow fires at most
 * once per logical event (e.g. one welcome per contact submission, one nudge
 * per recipient per campaign open) even if the source webhook is redelivered.
 */
export function eventSubjectKey(trigger: EventTrigger, parts: Array<string | null | undefined>): string {
  const tail = parts.map((p) => (p ?? '').trim().toLowerCase()).filter(Boolean).join(':');
  return `${trigger}:${tail || 'anon'}`;
}
