// lib/concierge/apply.ts — Concierge deeper write-back (pure, tested).
//
// The concierge already creates/updates plans and can drop a dated plan on the
// calendar. "Deeper write-back" turns an ACCEPTED plan into the RIGHT set of real
// records across MORE surfaces — a calendar event, a reminder to act on it, and a
// prep task — each idempotently tracked in concierge_plan_actions so a plan never
// double-materializes and the family can see exactly what the concierge did.
// Pure decision logic here; the server action performs the writes.

export type WriteBackKind = 'calendar' | 'reminder' | 'task';

export interface PlanForApply {
  title: string;
  planned_for: string | null; // 'YYYY-MM-DD' or null
  budget_cents?: number | null;
  location?: string | null;
}

export interface WriteBackOption {
  kind: WriteBackKind;
  label: string;
  /** True when this plan has enough info for this write-back. */
  available: boolean;
  reason?: string; // why it's unavailable (for the UI hint)
}

const DAY_MS = 86_400_000;

/**
 * Which write-backs make sense for a plan. Reminder + task are always available
 * (every plan can be nudged / prepped); calendar needs a date.
 */
export function planWriteBacks(plan: PlanForApply): WriteBackOption[] {
  const hasDate = !!plan.planned_for;
  return [
    { kind: 'calendar', label: 'Add to calendar', available: hasDate, reason: hasDate ? undefined : 'No date yet' },
    { kind: 'reminder', label: 'Remind me', available: true },
    { kind: 'task', label: 'Add a prep task', available: true },
  ];
}

/** Only the kinds that are actually available for this plan. */
export function availableWriteBackKinds(plan: PlanForApply): WriteBackKind[] {
  return planWriteBacks(plan).filter((o) => o.available).map((o) => o.kind);
}

/**
 * When to remind about a plan: 2 days before the planned date (but never in the
 * past) — or, when there's no date, 2 days from now. Returned as an ISO string.
 */
export function reminderLeadAt(plannedFor: string | null, now: Date = new Date()): string {
  if (plannedFor) {
    const planned = new Date(`${plannedFor}T09:00:00.000Z`).getTime();
    const twoBefore = planned - 2 * DAY_MS;
    return new Date(Math.max(twoBefore, now.getTime() + 60_000)).toISOString();
  }
  return new Date(now.getTime() + 2 * DAY_MS).toISOString();
}

/** The reminder/task title for a plan (kept short + actionable). */
export function writeBackTitle(kind: WriteBackKind, planTitle: string): string {
  const t = planTitle.trim() || 'Concierge plan';
  if (kind === 'task') return `Prep: ${t}`;
  if (kind === 'reminder') return `Follow up: ${t}`;
  return t;
}
