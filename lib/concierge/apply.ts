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

// ── What an approval was asked about ────────────────────────────────────────
//
// A queued plan is materialized later, by whoever says yes, from the plan row
// as it is THEN. Any active member may rewrite that row in the meantime (0091's
// `concierge_plans_family` policy is FOR ALL and reads no role), so a guest
// could retitle "Soccer Saturday" after the card went out and have a parent's
// yes put their text on the calendar and in reminders, in the parent's name.
// So the fields that become records are filed with the ask, and the yes runs
// only while the plan still says what was filed.

/** The fields of a plan that turn into records when it is materialized. */
export interface PlanSnapshot {
  title: string;
  description: string | null;
  location: string | null;
  planned_for: string | null;
}

type SnapshotSource = { title: string; description?: string | null; location?: string | null; planned_for: string | null };

/** The snapshot to file with a plan's approval or queued run. */
export function planSnapshot(plan: SnapshotSource): PlanSnapshot {
  return {
    title: plan.title,
    description: plan.description ?? null,
    location: plan.location ?? null,
    planned_for: plan.planned_for ?? null,
  };
}

const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';

/**
 * The snapshot a payload or a run's metadata carries, or null when it carries
 * none (a row filed before snapshots existed) or one that is not this shape.
 */
export function readPlanSnapshot(value: unknown): PlanSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== 'string') return null;
  if (!nullableText(record.description) || !nullableText(record.location) || !nullableText(record.planned_for)) return null;
  return { title: record.title, description: record.description, location: record.location, planned_for: record.planned_for };
}

/** Whether the plan as it is now is the plan the snapshot recorded, field for field. */
export function matchesPlanSnapshot(plan: SnapshotSource, snapshot: PlanSnapshot): boolean {
  const now = planSnapshot(plan);
  return now.title === snapshot.title
    && now.description === snapshot.description
    && now.location === snapshot.location
    && now.planned_for === snapshot.planned_for;
}
