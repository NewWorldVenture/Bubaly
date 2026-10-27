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
  'onboarding_abandoned',
  'demo_started',
  'demo_abandoned',
] as const;
export type EventTrigger = (typeof EVENT_TRIGGERS)[number];

export function isEventTrigger(trigger: string): trigger is EventTrigger {
  return (EVENT_TRIGGERS as readonly string[]).includes(trigger);
}

/**
 * The one step either runner executes (automation-steps.ts runSteps). Every
 * other action is recorded `<action>:unsupported` and does nothing, so the
 * console offers only this one.
 */
export const RUNNABLE_ACTIONS = ['send_email'] as const;

/**
 * The triggers the console may build a workflow on, each of which something
 * fires: the scheduled sweep (automation-runner.ts SCHEDULED_TRIGGERS) or an
 * app event (EVENT_TRIGGERS above). Not `joins_segment`, which nothing fires,
 * and not `customer_inactive`, whose rule needs an activity signal the
 * customer view does not have (lib/marketing/customers.ts `activityKnown`).
 * This is what the builder offers; whether a workflow can run is decided on
 * FIRED_TRIGGERS below, which also holds the app events the builder does not.
 */
export const CONSOLE_TRIGGERS = [
  'customer_created', 'form_submitted', 'payment_completed', 'payment_failed',
  'email_opened', 'email_clicked', 'checkout_abandoned', 'high_value_detected',
] as const;

/**
 * Every trigger something fires: the console's, and the app events the builder
 * does not offer — onboarding_completed (app/onboarding/actions.ts),
 * onboarding_abandoned and demo_abandoned (app/api/cron/journey-recovery).
 * fireAutomationEvent runs any active workflow on them, and the onboarding
 * welcome is one operators are told to switch on (docs/onboarding-supabase.md).
 * Deciding runnability on CONSOLE_TRIGGERS refused to resume such a workflow
 * once paused, and its card said nothing in it runs while it emailed every
 * family. Not `demo_started`, which nothing fires.
 */
export const FIRED_TRIGGERS = [
  ...CONSOLE_TRIGGERS, 'onboarding_completed', 'onboarding_abandoned', 'demo_abandoned',
] as const;

/** Whether something fires this trigger (FIRED_TRIGGERS), so a workflow on it can run at all. */
export function triggerFires(trigger: string): boolean {
  return (FIRED_TRIGGERS as readonly string[]).includes(trigger);
}

/**
 * Whether a workflow does everything it says: a trigger something fires and
 * only steps a runner executes. One that does not is refused activation — it
 * read `active` in the console while it sent nothing, or never ran at all.
 */
export function workflowIsRunnable(trigger: string, steps: unknown): boolean {
  if (!triggerFires(trigger)) return false;
  return stepsAreRunnable(steps);
}

/**
 * Whether the console switches this workflow on (setAutomationStatus): one
 * that does everything it says, or one on a trigger the app fires that the
 * builder does not offer (onboarding_completed, onboarding_abandoned,
 * demo_abandoned) with an email step. The runners send its email steps and
 * skip the rest, which is what its card says ("Only its email steps run").
 * On a builder trigger the console can make the email-only workflow instead;
 * on these it cannot, so refusing it left a paused onboarding welcome that
 * also held a tag step off for good, with no way back but SQL.
 */
export function workflowCanBeSwitchedOn(trigger: string, steps: unknown): boolean {
  if (workflowIsRunnable(trigger, steps)) return true;
  return triggerFires(trigger) && !(CONSOLE_TRIGGERS as readonly string[]).includes(trigger) && hasRunnableStep(steps);
}

/** Whether a runner executes this step (RUNNABLE_ACTIONS); any other is recorded `<action>:unsupported`. */
export function isRunnableStep(step: unknown): boolean {
  return !!step && typeof step === 'object'
    && (RUNNABLE_ACTIONS as readonly string[]).includes(String((step as { action?: unknown }).action));
}

/** Whether a runner executes every one of a workflow's steps, and there is at least one. */
export function stepsAreRunnable(steps: unknown): boolean {
  return Array.isArray(steps) && steps.length > 0 && steps.every(isRunnableStep);
}

/**
 * Whether a workflow's steps would do anything at all. A workflow switched on
 * before the console refused unrunnable ones (setAutomationStatus) can hold
 * only steps no runner executes — a lone send_sms, apply_tag, or nothing.
 * Run, it reserved a row per subject, recorded each `failed`, added each to
 * run_count and answered the cron 502, every day a new subject matched, while
 * sending nothing. Both runners skip such a workflow and report it instead.
 */
export function hasRunnableStep(steps: unknown): boolean {
  return Array.isArray(steps) && steps.some(isRunnableStep);
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
  onboarding_abandoned: {
    subject: 'Your family HQ is almost ready 👋',
    body: "You started setting up Bubaly but didn't quite finish — you're just a step or two from a shared family calendar, lists, and reminders. Pick up right where you left off; it only takes a minute.",
  },
  demo_started: {
    subject: 'How was your Bubaly demo? 👋',
    body: "Thanks for trying the live demo! You saw a real Family+ workspace in action. Ready to make it yours? Start your free 5-day trial — no card needed — and we'll set your family up in minutes.",
  },
  demo_abandoned: {
    subject: 'Ready to make your Bubaly demo real?',
    body: "You tried the live demo but haven't started your own family yet. Your free 5-day trial takes minutes to set up — no card needed — and keeps everything you loved about the demo.",
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
