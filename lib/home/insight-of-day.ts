// lib/home/insight-of-day.ts — the ONE proactive "insight of the day" (T4).
// Instead of many small reminders, the home surfaces a single, highest-impact,
// genuinely-helpful insight above the fold. This is the pure, deterministic core:
// it turns the family's live signals into scored candidate insights and ranks them
// so the home shows exactly one — dismiss it and the next-best surfaces. DOM-free +
// fully unit-tested; the server builds the sources, this decides what matters most.

export type InsightKind =
  | 'departure'        // leave earlier (traffic + weather) — source is key-gated
  | 'conflict'         // a schedule clash today/tomorrow
  | 'homework'         // assignments due tomorrow, not acknowledged
  | 'approval'         // decisions waiting on a parent
  | 'reminder_overdue' // reminders past due
  | 'renewal'          // a renewal expiring soon
  | 'document'         // a stored document expiring soon
  | 'meal'             // unplanned dinners — plan-ahead / grocery savings
  | 'grocery'          // running low on staples
  | 'autopilot';       // a high-confidence action Bubaly can take

export interface Insight {
  id: string;          // stable within a family/day (one per kind)
  kind: InsightKind;
  title: string;
  detail: string;
  href: string;
  impact: number;      // 0..100 — higher is more worth surfacing
}

export interface InsightSources {
  /** Leave-earlier nudge from traffic + weather (only present when Maps/weather is wired). */
  departure?: { leaveEarlierMinutes: number; eventTitle: string } | null;
  /** Schedule clashes happening today or tomorrow. */
  conflictsSoon?: { title: string; when: string }[];
  /** Assignments due tomorrow that haven't been acknowledged (still 'assigned'). */
  homeworkDueTomorrow?: { title: string; who: string | null }[];
  /** Money/permission decisions waiting on a parent. */
  pendingApprovals?: number;
  /** Reminders past their due time. */
  overdueReminders?: number;
  /** Renewals approaching expiry (days until). */
  renewalsSoon?: { title: string; days: number }[];
  /** Stored documents approaching expiry (days until). */
  documentsSoon?: { title: string; days: number }[];
  /** Dinners not yet planned in the next 7 days. */
  unplannedDinners?: number;
  /** Open grocery staples (a full-ish list → a shopping trip worth batching). */
  lowGrocery?: number;
  /** The single best autopilot suggestion (confidence 0..100). */
  autopilotTop?: { title: string; confidence: number } | null;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// Deterministic tie-break: when two insights score equal, this order wins. Roughly
// "safety/urgency → time-sensitive → planning-ahead".
const KIND_PRIORITY: InsightKind[] = [
  'departure', 'conflict', 'homework', 'approval', 'reminder_overdue',
  'renewal', 'document', 'autopilot', 'meal', 'grocery',
];

/**
 * Turn the family's live signals into scored candidate insights. Only signals that
 * are actually present produce a candidate, and each carries an impact score so the
 * ranker can pick the one most worth the family's attention today.
 */
export function buildInsightCandidates(s: InsightSources): Insight[] {
  const out: Insight[] = [];

  if (s.departure && s.departure.leaveEarlierMinutes > 0) {
    out.push({
      id: 'departure', kind: 'departure',
      title: `Leave ${s.departure.leaveEarlierMinutes} min earlier for ${s.departure.eventTitle}`,
      detail: 'Traffic and weather mean the usual timing runs late — a small head start avoids it.',
      href: '/dashboard/calendar',
      impact: clamp(88 + Math.min(s.departure.leaveEarlierMinutes, 10)),
    });
  }

  const conflicts = s.conflictsSoon ?? [];
  if (conflicts.length > 0) {
    const c = conflicts[0];
    out.push({
      id: 'conflict', kind: 'conflict',
      title: `A schedule clash ${c.when.toLowerCase()}`,
      detail: `${c.title} is double-booked — decide who covers what before it becomes a scramble.`,
      href: '/dashboard/conflicts',
      impact: clamp(90 + (conflicts.length - 1) * 2),
    });
  }

  const hw = s.homeworkDueTomorrow ?? [];
  if (hw.length > 0) {
    const names = hw.map((h) => h.who).filter(Boolean) as string[];
    const who = names.length > 0 ? ` (${Array.from(new Set(names)).slice(0, 2).join(', ')})` : '';
    out.push({
      id: 'homework', kind: 'homework',
      title: `${hw.length} assignment${hw.length === 1 ? '' : 's'} due tomorrow${who}`,
      detail: hw.length === 1 ? `“${hw[0].title}” hasn’t been acknowledged yet.` : 'They haven’t been acknowledged yet — a quick nudge tonight.',
      href: '/dashboard/homework',
      impact: clamp(78 + hw.length * 4),
    });
  }

  if ((s.pendingApprovals ?? 0) > 0) {
    const n = s.pendingApprovals!;
    out.push({
      id: 'approval', kind: 'approval',
      title: `${n} decision${n === 1 ? '' : 's'} waiting on you`,
      detail: 'A couple of quick approvals will unblock the family.',
      href: '/dashboard/autopilot',
      impact: clamp(70 + n * 2),
    });
  }

  if ((s.overdueReminders ?? 0) > 0) {
    const n = s.overdueReminders!;
    out.push({
      id: 'reminder_overdue', kind: 'reminder_overdue',
      title: `${n} reminder${n === 1 ? '' : 's'} slipped past due`,
      detail: 'Catch these up so nothing important falls through.',
      href: '/dashboard/reminders',
      impact: clamp(60 + n * 3),
    });
  }

  const renewal = (s.renewalsSoon ?? []).slice().sort((a, b) => a.days - b.days)[0];
  if (renewal) {
    out.push({
      id: 'renewal', kind: 'renewal',
      title: `${renewal.title} expires in ${renewal.days} day${renewal.days === 1 ? '' : 's'}`,
      detail: 'Renew it now while it’s in front of you.',
      href: '/dashboard/renewals',
      impact: clamp(renewal.days <= 3 ? 76 : renewal.days <= 7 ? 62 : 46),
    });
  }

  const doc = (s.documentsSoon ?? []).slice().sort((a, b) => a.days - b.days)[0];
  if (doc) {
    out.push({
      id: 'document', kind: 'document',
      title: `${doc.title} expires in ${doc.days} day${doc.days === 1 ? '' : 's'}`,
      detail: 'Update it before it lapses.',
      href: '/dashboard/documents',
      impact: clamp(doc.days <= 7 ? 68 : 50),
    });
  }

  if ((s.unplannedDinners ?? 0) > 0) {
    const n = s.unplannedDinners!;
    out.push({
      id: 'meal', kind: 'meal',
      title: `${n} dinner${n === 1 ? '' : 's'} this week aren’t planned`,
      detail: 'Plan them together now — buying for the week at once usually saves money.',
      href: '/dashboard/meals',
      impact: clamp(42 + n * 3),
    });
  }

  if ((s.lowGrocery ?? 0) > 0) {
    const n = s.lowGrocery!;
    out.push({
      id: 'grocery', kind: 'grocery',
      title: `${n} item${n === 1 ? '' : 's'} on the grocery list`,
      detail: 'One trip this week covers it — batch it to save time and money.',
      href: '/dashboard/grocery',
      impact: clamp(34 + n),
    });
  }

  if (s.autopilotTop && s.autopilotTop.confidence >= 70) {
    out.push({
      id: 'autopilot', kind: 'autopilot',
      title: s.autopilotTop.title,
      detail: 'Bubaly can handle this for you — just say the word.',
      href: '/dashboard/autopilot',
      impact: clamp(40 + (s.autopilotTop.confidence - 70)),
    });
  }

  return out;
}

/** Rank candidates: highest impact first, ties broken by kind priority then id. */
export function rankInsights(candidates: Insight[]): Insight[] {
  return [...(candidates ?? [])].sort((a, b) => {
    if (b.impact !== a.impact) return b.impact - a.impact;
    const pa = KIND_PRIORITY.indexOf(a.kind), pb = KIND_PRIORITY.indexOf(b.kind);
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}

/** The single insight of the day — the highest-impact candidate, or null if none. */
export function topInsight(candidates: Insight[]): Insight | null {
  const ranked = rankInsights(candidates);
  return ranked[0] ?? null;
}
