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
 *  Per-manager fan-out is expressed through `user_id`, so the
 *  (type, related_id, user_id) dedup key stays unique per recipient.
 *
 *  `related_id` names the OCCURRENCE, not just the row, because the engine
 *  dedupes on it PERMANENTLY. A signup has one deadline, so its id is enough.
 *  A renewal does not: "Mark renewed" rolls `expires_at` forward a year and
 *  keeps the row active (components/modules/renewals-module.tsx), so keyed by
 *  the row alone the first year's reminder stood in for every year after it —
 *  car insurance was announced once, ever. The key carries the expiry it is
 *  about; `entityIdFrom` (lib/notifications/actions.ts) still finds the uuid. */
export interface DeadlineReminder {
  type: 'document_expiry' | 'system';
  related_type: 'renewals' | 'opportunities';
  related_id: string;
  user_id: string | null;
  title: string;
  body: string;
  /**
   * The key this occurrence may ALREADY have been announced under, before the
   * key carried the expiry, and the instant from which such a row counts as
   * this occurrence's. Rows written under the old key (the renewal's id alone)
   * are still in the table; without this the first run after the change would
   * announce every renewal already inside its window a second time (audit note
   * of 2026-10-04 07:34 UTC on #936). A legacy row created before `since` —
   * the start of this occurrence's lead window — belongs to an earlier year
   * and does not count.
   */
  legacy?: { related_id: string; since: string };
}

/** `YYYY-MM-DD` moved by `days`, in UTC arithmetic on a date-only value (no zone, no DST). */
function dayKeyPlus(key: string, days: number): string {
  const [y, m, d] = key.slice(0, 10).split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return key;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
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
      type: 'document_expiry', related_type: 'renewals', related_id: `${r.id}:${r.expires_at}`,
      title: `Renewal due: ${r.title}`,
      body: `Expires ${fmtDate(r.expires_at)} · ${daysLabel(d)}`,
      // Announced under the bare id before this key existed: a row from inside
      // this occurrence's own window (expiry minus its lead) is this occurrence.
      legacy: { related_id: r.id, since: `${dayKeyPlus(r.expires_at, -r.reminder_days)}T00:00:00.000Z` },
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
