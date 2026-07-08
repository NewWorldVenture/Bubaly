// lib/guardian/learning.ts — Adaptive AI Learning for AI Call Guardian™.
//
// The AI observes the family's communication history and PROPOSES changes —
// it never applies them. Every proposal lands in `guardian_suggestions` for a
// parent to approve or dismiss (the human-in-the-loop guarantee from the spec).
//
// This module is the pure analysis core: communications + contacts in →
// de-duplicated suggestion drafts out. All I/O (reads, inserts) lives in the
// caller (server action / cron), so this stays deterministic and unit-testable.

import type { TrustLevel } from './trust';
import { TRUST_RANK } from './trust';

/** Minimal shape of a communication row needed for pattern analysis. */
export type CommSummary = {
  from_number: string | null;
  contact_id: string | null;
  scam_detected: boolean;
  trust_level_at_time: TrustLevel | null;
  started_at: string;     // ISO timestamp
};

/** Minimal shape of a contact row needed for pattern analysis. */
export type ContactSummary = {
  id: string;
  phone: string | null;
  name: string | null;
  trust_level: TrustLevel;
  trust_override: boolean;  // parent set it manually — don't second-guess
};

export type SuggestionDraft = {
  suggestion_type: 'block_contact' | 'update_trust' | 'new_rule' | 'flag_scam';
  title: string;
  reasoning: string;
  evidence: Record<string, unknown>;
  proposed_contact_id?: string | null;
  proposed_trust_level?: TrustLevel | null;
  proposed_rule_data?: Record<string, unknown> | null;
  /** Stable key used to avoid inserting the same suggestion twice. */
  dedupeKey: string;
};

// Thresholds (tuned conservatively — we'd rather under-suggest than nag).
export const REPEAT_SCAM_THRESHOLD = 2;       // scam hits before we propose a block
export const FREQUENT_UNKNOWN_THRESHOLD = 4;  // calls/texts before "add to contacts?"
export const PROVEN_SAFE_THRESHOLD = 6;        // safe interactions before trust upgrade
export const NIGHT_CALL_THRESHOLD = 3;         // off-hours unknown calls → quiet-hours rule

function isNightHour(iso: string): boolean {
  const h = new Date(iso).getUTCHours();
  // Treat 22:00–06:59 as "night". (Family-local refinement happens via the
  // rule's own time window; this is just the signal that prompts the rule.)
  return h >= 22 || h < 7;
}

/** Format a phone for human-readable suggestion copy (lightweight, no deps). */
function pretty(phone: string | null): string {
  if (!phone) return 'this caller';
  const d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return phone;
}

/**
 * Analyze recent communications + the trust graph and produce suggestion drafts.
 * Caller is responsible for filtering out drafts whose dedupeKey already exists
 * as a pending suggestion, and for inserting the rest.
 */
export function analyzeCommunications(input: {
  communications: CommSummary[];
  contacts: ContactSummary[];
}): SuggestionDraft[] {
  const { communications, contacts } = input;
  const drafts: SuggestionDraft[] = [];

  const contactByPhone = new Map<string, ContactSummary>();
  for (const c of contacts) if (c.phone) contactByPhone.set(c.phone, c);

  // Group comms by originating phone number.
  type Bucket = { total: number; scam: number; night: number; lastSeen: string; trustSeen: TrustLevel | null };
  const byPhone = new Map<string, Bucket>();
  for (const comm of communications) {
    if (!comm.from_number) continue;
    const b = byPhone.get(comm.from_number) ?? { total: 0, scam: 0, night: 0, lastSeen: comm.started_at, trustSeen: comm.trust_level_at_time };
    b.total += 1;
    if (comm.scam_detected) b.scam += 1;
    if (isNightHour(comm.started_at)) b.night += 1;
    if (comm.started_at > b.lastSeen) b.lastSeen = comm.started_at;
    byPhone.set(comm.from_number, b);
  }

  let nightUnknownCalls = 0;

  for (const [phone, b] of byPhone) {
    const contact = contactByPhone.get(phone);

    // ── Pattern 1: repeat scammer not yet blocked → propose block ──────────────
    if (b.scam >= REPEAT_SCAM_THRESHOLD && (!contact || contact.trust_level !== 'blocked')) {
      drafts.push({
        suggestion_type: contact ? 'block_contact' : 'flag_scam',
        title: `Block ${pretty(phone)}?`,
        reasoning: `Bubaly flagged ${pretty(phone)} as a scam ${b.scam} times. Blocking will hang up automatically on future calls and silently discard texts.`,
        evidence: { phone, scam_count: b.scam, total: b.total },
        proposed_contact_id: contact?.id ?? null,
        proposed_trust_level: 'blocked',
        dedupeKey: `block:${phone}`,
      });
      continue; // a phone we want blocked shouldn't also trigger an upgrade
    }

    // ── Pattern 2: frequent unknown caller, never a scam → add to contacts ─────
    const effectiveTrust = contact?.trust_level ?? b.trustSeen ?? 'unknown';
    if (
      !contact &&
      b.scam === 0 &&
      b.total >= FREQUENT_UNKNOWN_THRESHOLD &&
      effectiveTrust === 'unknown'
    ) {
      drafts.push({
        suggestion_type: 'update_trust',
        title: `Add ${pretty(phone)} to your contacts?`,
        reasoning: `${pretty(phone)} has reached you ${b.total} times with no scam signals. Saving them as a known contact lets Bubaly route their calls the way you prefer.`,
        evidence: { phone, total: b.total },
        proposed_trust_level: 'known_contact',
        dedupeKey: `trust:${phone}:known_contact`,
      });
    }

    // ── Pattern 4 signal: count off-hours calls from non-trusted numbers ───────
    if (b.night > 0 && TRUST_RANK[effectiveTrust] <= TRUST_RANK['known_contact']) {
      nightUnknownCalls += b.night;
    }
  }

  // ── Pattern 3: a proven-safe known contact → propose trust upgrade ───────────
  // Count safe interactions per saved contact (by contact_id).
  const safeByContact = new Map<string, number>();
  for (const comm of communications) {
    if (comm.contact_id && !comm.scam_detected) {
      safeByContact.set(comm.contact_id, (safeByContact.get(comm.contact_id) ?? 0) + 1);
    }
  }
  for (const contact of contacts) {
    if (contact.trust_override) continue;          // parent already decided
    if (contact.trust_level !== 'known_contact') continue;
    const safe = safeByContact.get(contact.id) ?? 0;
    if (safe >= PROVEN_SAFE_THRESHOLD) {
      drafts.push({
        suggestion_type: 'update_trust',
        title: `Promote ${contact.name ?? pretty(contact.phone)} to a trusted friend?`,
        reasoning: `${contact.name ?? pretty(contact.phone)} has had ${safe} safe interactions and never triggered a scam flag. Promoting to "Trusted Friend" lets their calls ring through immediately.`,
        evidence: { contact_id: contact.id, safe_interactions: safe },
        proposed_contact_id: contact.id,
        proposed_trust_level: 'trusted_friend',
        dedupeKey: `trust:${contact.id}:trusted_friend`,
      });
    }
  }

  // ── Pattern 4: lots of off-hours unknown calls → propose a quiet-hours rule ──
  if (nightUnknownCalls >= NIGHT_CALL_THRESHOLD) {
    drafts.push({
      suggestion_type: 'new_rule',
      title: 'Add a Quiet Hours rule for unknown callers?',
      reasoning: `You've had ${nightUnknownCalls} late-night calls from unknown or low-trust numbers. A Quiet Hours rule sends unknown callers straight to silent AI handling between 10 PM and 7 AM, so they never wake the house.`,
      evidence: { night_calls: nightUnknownCalls },
      proposed_rule_data: {
        name: 'Quiet Hours — unknown callers',
        description: 'Auto-suggested: silently handle unknown/spam callers overnight.',
        priority: 50,
        is_active: true,
        condition_trust_levels: ['unknown', 'suspected_spam'],
        condition_time_start: '22:00',
        condition_time_end: '07:00',
        action_routing_mode: 'silent_handling',
      },
      dedupeKey: 'rule:quiet_hours_unknown',
    });
  }

  return drafts;
}
