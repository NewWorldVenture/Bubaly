// lib/notifications/deadline-reminders.ts — pure builders that turn upcoming
// renewals and signups into notification rows for the "who needs to know"
// engine. Kept free of Supabase so the windowing + fan-out is unit testable.
// Reuses the already-tested deadline math from the renewals / opportunities libs.

import { daysToExpiry, type RenewalStatus } from '@/lib/renewals/expiry';
import { daysToDeadline, type OpportunityStatus } from '@/lib/opportunities/deadlines';

export interface ManagerLite { id: string; user_id: string | null }

export interface RenewalInput { id: string; title: string; expires_at: string; reminder_days: number; status: RenewalStatus }
export interface OpportunityInput { id: string; title: string; deadline: string | null; status: OpportunityStatus }

/** A notification row, shaped to match the engine's Candidate (minus family_id).
 *  `related_id` is always the item's own UUID; per-manager fan-out is expressed
 *  through `user_id` so the (type, related_id, user_id) dedup key stays unique
 *  without stuffing a non-UUID composite into the uuid column. */
export interface DeadlineReminder {
  type: 'document_expiry' | 'system';
  related_type: 'renewals' | 'opportunities';
  related_id: string;
  user_id: string | null;
  title: string;
  body: string;
}

function fmtDate(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function daysLabel(d: number): string {
  if (d <= 0) return 'due today';
  return `${d} day${d === 1 ? '' : 's'} left`;
}

/** Fans a single reminder out to every manager (or one family-wide row when
 *  there are no managers). */
function fanOut(
  managers: ManagerLite[],
  base: Omit<DeadlineReminder, 'user_id'>,
): DeadlineReminder[] {
  if (managers.length === 0) return [{ ...base, user_id: null }];
  return managers.map((m) => ({ ...base, user_id: m.user_id }));
}

/**
 * Reminders for active renewals currently inside their OWN `reminder_days` lead
 * window (0 … reminder_days days out). Already-expired and inactive renewals are
 * skipped — those are surfaced in the app, not re-notified.
 */
export function renewalReminders(renewals: RenewalInput[], managers: ManagerLite[], todayKey: string): DeadlineReminder[] {
  const out: DeadlineReminder[] = [];
  for (const r of renewals) {
    if (r.status !== 'active') continue;
    const d = daysToExpiry({ id: r.id, expires_at: r.expires_at, reminder_days: r.reminder_days, status: 'active' }, todayKey);
    if (d < 0 || d > r.reminder_days) continue;
    out.push(...fanOut(managers, {
      type: 'document_expiry', related_type: 'renewals', related_id: r.id,
      title: `Renewal due: ${r.title}`,
      body: `Expires ${fmtDate(r.expires_at)} · ${daysLabel(d)}`,
    }));
  }
  return out;
}

/**
 * Reminders for open signups (interested / waitlisted) whose registration
 * deadline is within `soonDays` (default 7) and not past.
 */
export function opportunityReminders(opps: OpportunityInput[], managers: ManagerLite[], todayKey: string, soonDays = 7): DeadlineReminder[] {
  const out: DeadlineReminder[] = [];
  for (const o of opps) {
    if (o.status !== 'interested' && o.status !== 'waitlisted') continue;
    const d = daysToDeadline({ id: o.id, deadline: o.deadline, status: 'interested' }, todayKey);
    if (d == null || d < 0 || d > soonDays) continue;
    out.push(...fanOut(managers, {
      type: 'system', related_type: 'opportunities', related_id: o.id,
      title: `Signup closing: ${o.title}`,
      body: `Deadline ${fmtDate(o.deadline!)} · ${daysLabel(d)}`,
    }));
  }
  return out;
}
