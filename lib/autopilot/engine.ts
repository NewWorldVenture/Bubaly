// lib/autopilot/engine.ts — the Family Autopilot prediction engine.
//
// Pure + deterministic: the route hands it a normalized snapshot of the
// family's real data and it returns confidence-scored suggestion drafts. No
// I/O, so every rule + confidence threshold is unit-tested. The route persists
// the drafts to `autopilot_suggestions` and auto-executes the high-confidence
// ones.
//
// Confidence tiers (the heart of "autopilot"):
//   >= 90  → auto  : safe enough to do automatically
//   70-89  → approve: do it, but confirm with the family first
//   < 70   → ask   : surface as awareness / a question

export type ConfidenceTier = 'auto' | 'approve' | 'ask';

export const AUTO_THRESHOLD = 90;
export const APPROVE_THRESHOLD = 70;

export function confidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= AUTO_THRESHOLD) return 'auto';
  if (confidence >= APPROVE_THRESHOLD) return 'approve';
  return 'ask';
}

export type SuggestionDraft = {
  kind: string;
  title: string;
  detail: string | null;
  confidence: number;
  urgency: 1 | 2 | 3;
  actionType: string | null;
  actionLabel: string | null;
  payload: Record<string, unknown>;
  sourceKind: string | null;
  sourceId: string | null;
  memberId: string | null;
  dedupeKey: string;
  expiresAt: string | null;
};

// ---- normalized inputs the route maps real Supabase rows into ----
export type RenewalSignal = { id: string; label: string; expiresOn: string };
export type AppointmentSignal = { id: string; title: string; startsAt: string; memberId: string | null; hasReminder: boolean };
export type ChoreSignal = { id: string; title: string; dueAt: string | null; memberId: string | null };
export type BirthdaySignal = { memberId: string; name: string; birthday: string }; // birthday = YYYY-MM-DD (year ignored)
export type GrocerySignal = { id: string; name: string; addedAt: string };
export type EventSignal = { id: string; title: string; startsAt: string; endsAt: string | null; memberId: string | null };

export type FamilySnapshot = {
  today: string; // YYYY-MM-DD
  renewals: RenewalSignal[];
  appointments: AppointmentSignal[];
  overdueChores: ChoreSignal[];
  birthdays: BirthdaySignal[];
  lingeringGroceries: GrocerySignal[];
  events: EventSignal[];
};

const DAY_MS = 86_400_000;

function isoDay(s: string): string {
  return s.slice(0, 10);
}
function daysUntil(today: string, target: string): number {
  return Math.round((Date.parse(`${isoDay(target)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}
function clampUrgency(n: number): 1 | 2 | 3 {
  return (n <= 1 ? 1 : n >= 3 ? 3 : 2) as 1 | 2 | 3;
}

/** Days until the NEXT occurrence of a MM-DD birthday from `today`. */
export function daysUntilBirthday(today: string, birthday: string): number {
  const [, bm, bd] = isoDay(birthday).split('-').map(Number);
  const todayD = new Date(`${today}T00:00:00Z`);
  const year = todayD.getUTCFullYear();
  let next = Date.UTC(year, bm - 1, bd);
  if (next < todayD.getTime()) next = Date.UTC(year + 1, bm - 1, bd);
  return Math.round((next - todayD.getTime()) / DAY_MS);
}

// ---- per-category rules ----

export function renewalSuggestions(s: FamilySnapshot): SuggestionDraft[] {
  return s.renewals
    .map((r) => ({ r, d: daysUntil(s.today, r.expiresOn) }))
    .filter(({ d }) => d >= 0 && d <= 30)
    .map(({ r, d }) => {
      const confidence = d <= 7 ? 95 : d <= 14 ? 82 : 72;
      return {
        kind: 'document',
        title: d <= 0 ? `${r.label} expires today` : `${r.label} expires in ${d} day${d === 1 ? '' : 's'}`,
        detail: 'Set a reminder so this never lapses.',
        confidence,
        urgency: clampUrgency(d <= 3 ? 3 : d <= 14 ? 2 : 1),
        actionType: 'create_reminder',
        actionLabel: 'Add renewal reminder',
        payload: { title: `Renew ${r.label}`, remindOffsetDays: Math.max(0, d - 3) },
        sourceKind: 'renewals',
        sourceId: r.id,
        memberId: null,
        dedupeKey: `renewal:${r.id}`,
        expiresAt: `${isoDay(r.expiresOn)}T23:59:59Z`,
      };
    });
}

export function appointmentSuggestions(s: FamilySnapshot): SuggestionDraft[] {
  return s.appointments
    .filter((a) => !a.hasReminder)
    .map((a) => ({ a, d: daysUntil(s.today, a.startsAt) }))
    .filter(({ d }) => d >= 0 && d <= 1)
    .map(({ a, d }) => ({
      kind: 'appointment',
      title: d === 0 ? `${a.title} is today` : `${a.title} is tomorrow`,
      detail: 'No reminder is set yet — want one?',
      confidence: 86,
      urgency: clampUrgency(d === 0 ? 3 : 2),
      actionType: 'create_reminder',
      actionLabel: 'Remind me',
      payload: { title: a.title, at: a.startsAt },
      sourceKind: 'appointments',
      sourceId: a.id,
      memberId: a.memberId,
      dedupeKey: `appt:${a.id}`,
      expiresAt: `${isoDay(a.startsAt)}T23:59:59Z`,
    }));
}

export function choreSuggestions(s: FamilySnapshot): SuggestionDraft[] {
  return s.overdueChores.map((c) => ({
    kind: 'chore',
    title: `Overdue: ${c.title}`,
    detail: 'This chore slipped past its due date.',
    confidence: 74,
    urgency: 2,
    actionType: 'nudge',
    actionLabel: 'Send a nudge',
    payload: { choreId: c.id },
    sourceKind: 'chore_assignments',
    sourceId: c.id,
    memberId: c.memberId,
    dedupeKey: `chore:${c.id}`,
    expiresAt: null,
  }));
}

export function birthdaySuggestions(s: FamilySnapshot): SuggestionDraft[] {
  return s.birthdays
    .map((b) => ({ b, d: daysUntilBirthday(s.today, b.birthday) }))
    .filter(({ d }) => d >= 0 && d <= 14)
    .map(({ b, d }) => ({
      kind: 'birthday',
      title: d === 0 ? `${b.name}'s birthday is today! 🎉` : `${b.name}'s birthday in ${d} day${d === 1 ? '' : 's'}`,
      detail: 'Plan a gift, a cake, or a celebration.',
      confidence: d <= 7 ? 88 : 78,
      urgency: clampUrgency(d <= 2 ? 3 : d <= 7 ? 2 : 1),
      actionType: 'plan_celebration',
      actionLabel: 'Plan celebration',
      payload: { memberId: b.memberId, name: b.name },
      sourceKind: 'family_members',
      sourceId: b.memberId,
      memberId: b.memberId,
      dedupeKey: `birthday:${b.memberId}`,
      expiresAt: null,
    }));
}

export function grocerySuggestions(s: FamilySnapshot): SuggestionDraft[] {
  return s.lingeringGroceries
    .map((g) => ({ g, age: -daysUntil(s.today, g.addedAt) }))
    .filter(({ age }) => age >= 7)
    .map(({ g }) => ({
      kind: 'groceries',
      title: `Still need: ${g.name}`,
      detail: 'It has been on the list a while — keep it or clear it?',
      confidence: 91,
      urgency: 1 as const,
      actionType: 'keep_grocery',
      actionLabel: 'Keep on list',
      payload: { itemId: g.id, name: g.name },
      sourceKind: 'grocery_items',
      sourceId: g.id,
      memberId: null,
      dedupeKey: `grocery:${g.id}`,
      expiresAt: null,
    }));
}

/** Do two time ranges overlap? End defaults to a 1h block when missing. */
function overlaps(aStart: string, aEnd: string | null, bStart: string, bEnd: string | null): boolean {
  const as = Date.parse(aStart);
  const ae = aEnd ? Date.parse(aEnd) : as + 3_600_000;
  const bs = Date.parse(bStart);
  const be = bEnd ? Date.parse(bEnd) : bs + 3_600_000;
  return as < be && bs < ae;
}

/**
 * Detect double-bookings: two events on the same day overlapping in time. A
 * clash for the SAME member is higher-confidence (they literally can't be in
 * two places); a family-wide clash (different/unassigned members) is awareness.
 */
export function conflictSuggestions(s: FamilySnapshot): SuggestionDraft[] {
  const out: SuggestionDraft[] = [];
  const seen = new Set<string>();
  const todays = s.events.filter((e) => {
    const d = daysUntil(s.today, e.startsAt);
    return d >= 0 && d <= 1;
  });
  for (let i = 0; i < todays.length; i++) {
    for (let j = i + 1; j < todays.length; j++) {
      const a = todays[i];
      const b = todays[j];
      if (isoDay(a.startsAt) !== isoDay(b.startsAt)) continue;
      if (!overlaps(a.startsAt, a.endsAt, b.startsAt, b.endsAt)) continue;
      const sameMember = a.memberId && b.memberId && a.memberId === b.memberId;
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'conflict',
        title: `Schedule clash: "${a.title}" overlaps "${b.title}"`,
        detail: sameMember ? 'Same person is double-booked.' : 'Two things overlap — who covers which?',
        confidence: sameMember ? 84 : 68,
        urgency: 3,
        actionType: 'review_conflict',
        actionLabel: 'Resolve clash',
        payload: { eventIds: [a.id, b.id], titles: [a.title, b.title] },
        sourceKind: 'calendar_events',
        sourceId: a.id,
        memberId: sameMember ? a.memberId : null,
        dedupeKey: `conflict:${key}`,
        expiresAt: `${isoDay(a.startsAt)}T23:59:59Z`,
      });
    }
  }
  return out;
}

/** Run every rule and return all suggestion drafts, highest urgency/confidence first. */
export function buildSuggestions(s: FamilySnapshot): SuggestionDraft[] {
  const all = [
    ...renewalSuggestions(s),
    ...appointmentSuggestions(s),
    ...choreSuggestions(s),
    ...birthdaySuggestions(s),
    ...grocerySuggestions(s),
    ...conflictSuggestions(s),
  ];
  return all.sort((a, b) => b.urgency - a.urgency || b.confidence - a.confidence);
}

/**
 * A 0-100 "today's success probability": starts at 100 and subtracts a penalty
 * per open risk weighted by urgency. High-confidence auto-handled items count
 * for less because the autopilot already has them.
 */
export function successProbability(drafts: SuggestionDraft[]): number {
  let penalty = 0;
  for (const d of drafts) {
    const base = d.urgency === 3 ? 12 : d.urgency === 2 ? 6 : 2;
    penalty += confidenceTier(d.confidence) === 'auto' ? base * 0.4 : base;
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

export function partitionByTier(drafts: SuggestionDraft[]): Record<ConfidenceTier, SuggestionDraft[]> {
  const out: Record<ConfidenceTier, SuggestionDraft[]> = { auto: [], approve: [], ask: [] };
  for (const d of drafts) out[confidenceTier(d.confidence)].push(d);
  return out;
}
