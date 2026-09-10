// lib/concierge/digest.ts — the cross-domain "AI Concierge" digest.
//
// This is the deterministic engine behind the product's north-star question:
// "What does my family need to do today?" The Daily Briefing already renders a
// timeline of calendar events; this digest surfaces the *deadline-bearing
// obligations that live outside the calendar* and are easy to forget — bills
// due, medications scheduled today, home maintenance, expiring warranties,
// upcoming trips, and food about to spoil — so nothing falls through the cracks.
//
// It is intentionally pure (no Supabase, no AI, no clock access beyond the
// `now` you pass): the API route gathers the raw rows, this classifies and
// ranks them, and the same result both *grounds the AI* and serves as a
// guaranteed, never-fabricated answer when AI is unconfigured.

export type ConciergeDomain =
  | 'bill'
  | 'medication'
  | 'maintenance'
  | 'warranty'
  | 'trip'
  | 'pantry';

export type ConciergeUrgency = 'overdue' | 'today' | 'soon';

type DisplayBase = { version: 1; name: string; dayOffset: number };
export type ConciergeItemDisplay = DisplayBase & (
  | { kind: 'bill'; amount: number | null }
  | { kind: 'medication'; member: string | null; timeOfDay: string | null }
  | { kind: 'maintenance' | 'warranty' | 'pantry' }
  | { kind: 'trip'; phase: 'ongoing' | 'departure'; destination: string | null }
);

export interface ConciergeItem {
  domain: ConciergeDomain;
  urgency: ConciergeUrgency;
  title: string;
  detail: string;
  member?: string;
  /** Human label for the deadline, e.g. "today", "tomorrow", "in 3 days". */
  dueLabel: string;
  /** Day offset from `now` (negative = past). Used for stable ordering. */
  dayOffset: number;
  /** Optional presentation facts; legacy prose and canonical ordering stay unchanged. */
  display?: ConciergeItemDisplay;
}

export interface ConciergeSnapshot {
  now: string | Date;
  bills?: { name: string; amount?: number | null; dueDate: string | null; status?: string | null }[];
  /** Medications already filtered by the caller to those scheduled *today*. */
  medications?: { name: string; member?: string | null; timeOfDay?: string | null }[];
  maintenance?: { title: string; dueAt: string | null }[];
  warranties?: { name: string; expiresOn: string | null }[];
  trips?: { title: string; startDate: string | null; endDate?: string | null; destination?: string | null }[];
  pantry?: { name: string; expiresAt: string | null }[];
}

export interface ConciergeDigest {
  items: ConciergeItem[];
  counts: { overdue: number; today: number; soon: number; total: number };
  byDomain: { domain: ConciergeDomain; count: number }[];
  /** One-sentence deterministic summary suitable for a header or AI grounding. */
  headline: string;
}

/** How many days ahead each domain stays "soon" (worth surfacing early). */
const SOON_WINDOW_DAYS: Record<ConciergeDomain, number> = {
  bill: 7,
  medication: 0,
  maintenance: 7,
  warranty: 30,
  trip: 14,
  pantry: 5,
};

const URGENCY_RANK: Record<ConciergeUrgency, number> = { overdue: 0, today: 1, soon: 2 };
const DOMAIN_RANK: Record<ConciergeDomain, number> = {
  medication: 0,
  bill: 1,
  maintenance: 2,
  pantry: 3,
  trip: 4,
  warranty: 5,
};

/** Calendar-day offset between an ISO date/datetime and `now` (date-only math). */
export function dayOffset(target: string | Date, now: string | Date): number | null {
  const t = typeof target === 'string' ? new Date(target) : target;
  const n = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(t.getTime()) || Number.isNaN(n.getTime())) return null;
  const tUTC = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const nUTC = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.round((tUTC - nUTC) / 86_400_000);
}

/** Render a day offset as a friendly relative label. */
export function dueLabelFor(offset: number): string {
  if (offset === 0) return 'today';
  if (offset === 1) return 'tomorrow';
  if (offset === -1) return 'yesterday';
  if (offset > 1) return `in ${offset} days`;
  return `${-offset} days ago`;
}

function classify(offset: number, windowDays: number): ConciergeUrgency | null {
  if (offset < 0) return 'overdue';
  if (offset === 0) return 'today';
  if (offset <= windowDays) return 'soon';
  return null;
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Canonical source text, also used to reject stale presentation facts without parsing prose. */
export function canonicalConciergeText(facts: ConciergeItemDisplay): Pick<ConciergeItem, 'title' | 'detail' | 'member' | 'dueLabel'> {
  const label = dueLabelFor(facts.dayOffset);
  switch (facts.kind) {
    case 'bill': return { title: facts.name, detail: facts.amount !== null ? `${money(facts.amount)} due ${label}` : `Due ${label}`, dueLabel: label };
    case 'medication': {
      const parts = [facts.member, facts.timeOfDay].filter(Boolean);
      return { title: facts.name, detail: parts.length ? parts.join(' · ') : 'Scheduled today', member: facts.member ?? undefined, dueLabel: 'today' };
    }
    case 'maintenance': return { title: facts.name, detail: `Due ${label}`, dueLabel: label };
    case 'pantry': return { title: facts.name, detail: facts.dayOffset < 0 ? `Expired ${label}` : `Expires ${label}`, dueLabel: label };
    case 'warranty': return { title: `${facts.name} warranty`, detail: facts.dayOffset < 0 ? `Expired ${label}` : `Expires ${label}`, dueLabel: label };
    case 'trip': {
      const detail = facts.phase === 'ongoing' ? 'In progress' : `Departs ${label}`;
      return { title: facts.name, detail: facts.destination ? `${detail} · ${facts.destination}` : detail, dueLabel: facts.phase === 'ongoing' ? 'in progress' : label };
    }
  }
}

/**
 * Build the prioritized cross-domain digest from a raw snapshot. Items are
 * sorted overdue → today → soon, then by soonest deadline, then by a stable
 * domain priority (medications first — they're time-critical and recurring).
 */
export function buildConciergeDigest(snapshot: ConciergeSnapshot): ConciergeDigest {
  const { now } = snapshot;
  const items: ConciergeItem[] = [];

  // ── Bills (skip paid) ─────────────────────────────────────────────────────
  for (const b of snapshot.bills ?? []) {
    if (!b.dueDate || (b.status ?? '').toLowerCase() === 'paid') continue;
    const off = dayOffset(b.dueDate, now);
    if (off === null) continue;
    const urgency = classify(off, SOON_WINDOW_DAYS.bill);
    if (!urgency) continue;
    const display: ConciergeItemDisplay = { version: 1, kind: 'bill', name: b.name, amount: b.amount ?? null, dayOffset: off };
    items.push({
      domain: 'bill',
      urgency,
      ...canonicalConciergeText(display),
      dayOffset: off,
      display,
    });
  }

  // ── Medications scheduled today ───────────────────────────────────────────
  for (const m of snapshot.medications ?? []) {
    const display: ConciergeItemDisplay = { version: 1, kind: 'medication', name: m.name, member: m.member ?? null, timeOfDay: m.timeOfDay ?? null, dayOffset: 0 };
    items.push({
      domain: 'medication',
      urgency: 'today',
      ...canonicalConciergeText(display),
      dayOffset: 0,
      display,
    });
  }

  // ── Home maintenance tasks ────────────────────────────────────────────────
  for (const t of snapshot.maintenance ?? []) {
    if (!t.dueAt) continue;
    const off = dayOffset(t.dueAt, now);
    if (off === null) continue;
    const urgency = classify(off, SOON_WINDOW_DAYS.maintenance);
    if (!urgency) continue;
    const display: ConciergeItemDisplay = { version: 1, kind: 'maintenance', name: t.title, dayOffset: off };
    items.push({
      domain: 'maintenance',
      urgency,
      ...canonicalConciergeText(display),
      dayOffset: off,
      display,
    });
  }

  // ── Pantry items about to expire ──────────────────────────────────────────
  for (const p of snapshot.pantry ?? []) {
    if (!p.expiresAt) continue;
    const off = dayOffset(p.expiresAt, now);
    if (off === null) continue;
    const urgency = classify(off, SOON_WINDOW_DAYS.pantry);
    if (!urgency) continue;
    const display: ConciergeItemDisplay = { version: 1, kind: 'pantry', name: p.name, dayOffset: off };
    items.push({
      domain: 'pantry',
      urgency,
      ...canonicalConciergeText(display),
      dayOffset: off,
      display,
    });
  }

  // ── Upcoming / in-progress trips ──────────────────────────────────────────
  for (const tr of snapshot.trips ?? []) {
    if (!tr.startDate) continue;
    const startOff = dayOffset(tr.startDate, now);
    if (startOff === null) continue;
    const endOff = tr.endDate ? dayOffset(tr.endDate, now) : startOff;
    // In progress: started but not yet ended.
    if (startOff <= 0 && endOff !== null && endOff >= 0) {
      const display: ConciergeItemDisplay = { version: 1, kind: 'trip', phase: 'ongoing', name: tr.title, destination: tr.destination ?? null, dayOffset: 0 };
      items.push({
        domain: 'trip',
        urgency: 'today',
        ...canonicalConciergeText(display),
        dayOffset: 0,
        display,
      });
      continue;
    }
    const urgency = classify(startOff, SOON_WINDOW_DAYS.trip);
    if (!urgency) continue;
    const display: ConciergeItemDisplay = { version: 1, kind: 'trip', phase: 'departure', name: tr.title, destination: tr.destination ?? null, dayOffset: startOff };
    items.push({
      domain: 'trip',
      urgency,
      ...canonicalConciergeText(display),
      dayOffset: startOff,
      display,
    });
  }

  // ── Warranties expiring ───────────────────────────────────────────────────
  for (const w of snapshot.warranties ?? []) {
    if (!w.expiresOn) continue;
    const off = dayOffset(w.expiresOn, now);
    if (off === null) continue;
    const urgency = classify(off, SOON_WINDOW_DAYS.warranty);
    if (!urgency) continue;
    const display: ConciergeItemDisplay = { version: 1, kind: 'warranty', name: w.name, dayOffset: off };
    items.push({
      domain: 'warranty',
      urgency,
      ...canonicalConciergeText(display),
      dayOffset: off,
      display,
    });
  }

  // ── Sort: urgency → soonest deadline → domain priority → title ────────────
  items.sort((a, b) => {
    if (URGENCY_RANK[a.urgency] !== URGENCY_RANK[b.urgency]) {
      return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    }
    if (a.dayOffset !== b.dayOffset) return a.dayOffset - b.dayOffset;
    if (DOMAIN_RANK[a.domain] !== DOMAIN_RANK[b.domain]) {
      return DOMAIN_RANK[a.domain] - DOMAIN_RANK[b.domain];
    }
    return a.title.localeCompare(b.title);
  });

  const counts = {
    overdue: items.filter(i => i.urgency === 'overdue').length,
    today: items.filter(i => i.urgency === 'today').length,
    soon: items.filter(i => i.urgency === 'soon').length,
    total: items.length,
  };

  const domainCounts = new Map<ConciergeDomain, number>();
  for (const i of items) domainCounts.set(i.domain, (domainCounts.get(i.domain) ?? 0) + 1);
  const byDomain = [...domainCounts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || DOMAIN_RANK[a.domain] - DOMAIN_RANK[b.domain]);

  return { items, counts, byDomain, headline: buildHeadline(counts) };
}

function buildHeadline(counts: ConciergeDigest['counts']): string {
  if (counts.total === 0) return "You're all caught up — nothing needs attention right now.";
  const parts: string[] = [];
  if (counts.overdue) parts.push(`${counts.overdue} overdue`);
  if (counts.today) parts.push(`${counts.today} due today`);
  if (counts.soon) parts.push(`${counts.soon} coming up`);
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

/** Compact text rendering of the digest for grounding an LLM prompt. */
export function digestToPromptLines(digest: ConciergeDigest): string {
  if (digest.items.length === 0) return '- Nothing outstanding across bills, meds, home, trips, or pantry.';
  return digest.items
    .map(i => `- [${i.urgency.toUpperCase()}] (${i.domain}) ${i.title} — ${i.detail}`)
    .join('\n');
}
