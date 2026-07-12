// lib/autonomy/loop.ts — the Autonomous Execution Loop brain (pure, tested).
//
// Closes the last gap between "the AI recommends" and "the AI does": when a
// family ACCEPTS a concierge plan (status → booked/confirmed), the loop decides
// — from the family's own Trust & Permissions policies (0093 engine) — whether
// Bubaly executes the plan's write-backs immediately (autopilot), queues them
// for one-tap approval, or stays hands-off. Every autonomous run is audited in
// family_automation_runs (0022) and each materialized record in
// concierge_plan_actions, so the family can always see exactly what the AI did
// and why. No new schema: this module only DECIDES; the server action executes.

import type { Decision, PolicyEffect } from '@/lib/trust/engine';
import type { WriteBackKind } from '@/lib/concierge/apply';

/** Plan statuses that mean "the family said yes — make it real". */
export const ACCEPTED_STATUSES = ['booked', 'confirmed'] as const;

/** The trust-engine coordinates the loop is governed by. */
export const AUTOPILOT_DOMAIN = 'scheduling';
export const AUTOPILOT_CAPABILITY = 'automate' as const;
export const AUTOPILOT_POLICY_NAME = 'Concierge autopilot';
export const AUTOPILOT_AGENT = 'concierge';

/** The family-facing dial. */
export type AutopilotLevel = 'auto' | 'ask' | 'off';

export type AutonomyMode = 'auto' | 'ask' | 'off';

/**
 * True only on the transition INTO an accepted status — so re-saving an
 * already-accepted plan (or moving booked → confirmed) never re-fires the loop.
 */
export function isAcceptance(prevStatus: string, nextStatus: string): boolean {
  const set = ACCEPTED_STATUSES as readonly string[];
  return set.includes(nextStatus) && !set.includes(prevStatus);
}

/** Map a trust-engine decision onto what the loop may do. */
export function autonomyMode(decision: Pick<Decision, 'effect'>): AutonomyMode {
  if (decision.effect === 'allow') return 'auto';
  if (decision.effect === 'require_approval') return 'ask';
  return 'off';
}

/** The policy effect each dial level writes to the family's trust policies. */
export function dialEffect(level: AutopilotLevel): PolicyEffect {
  return level === 'auto' ? 'allow' : level === 'ask' ? 'require_approval' : 'deny';
}

/** The dial level a stored policy effect reads back as. */
export function dialLevel(effect: string | null | undefined): AutopilotLevel {
  if (effect === 'allow' || effect === 'auto_approve') return 'auto';
  if (effect === 'deny') return 'off';
  return 'ask'; // require_approval — and the safe default when no policy exists
}

const STEP_PHRASE: Record<WriteBackKind, string> = {
  calendar: 'put it on the calendar',
  reminder: 'set a follow-up reminder',
  task: 'added a prep task',
};

/** Plain-language one-liner for the run audit ("what Bubaly did"). */
export function runSummary(planTitle: string, applied: WriteBackKind[]): string {
  const t = planTitle.trim() || 'your plan';
  if (applied.length === 0) return `“${t}” accepted — everything was already in place.`;
  const parts = applied.map((k) => STEP_PHRASE[k]);
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `“${t}” accepted — Bubaly ${list}.`;
}

/** What the approval card asks when the dial is on "ask first". */
export function approvalTitle(planTitle: string): string {
  return `Execute plan: ${planTitle.trim() || 'Untitled plan'}`;
}

// ── Panel stats ──────────────────────────────────────────────────────────────

export interface RunLite {
  status: string;              // pending | executed | dismissed | …
  trigger_type: string | null;
  created_at: string;
}

export interface AutopilotStats {
  executedThisWeek: number;
  pending: number;
  totalExecuted: number;
}

/** Header numbers for the Autopilot panel (loop-triggered runs only). */
export function autopilotStats(runs: RunLite[], now: Date = new Date()): AutopilotStats {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  let executedThisWeek = 0, pending = 0, totalExecuted = 0;
  for (const r of runs) {
    if (r.trigger_type !== 'plan_accepted') continue;
    if (r.status === 'executed') {
      totalExecuted++;
      if (new Date(r.created_at).getTime() >= weekAgo) executedThisWeek++;
    } else if (r.status === 'pending') {
      pending++;
    }
  }
  return { executedThisWeek, pending, totalExecuted };
}
