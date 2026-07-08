// Design for Calm (North Star pillar #8) — pure, unit-tested. The strongest
// differentiator isn't more notifications, it's FEWER: one prioritized inbox, a
// gentle daily digest, and escalation only when something truly needs a person.
// This engine folds every signal source (agents, autopilot, the Operating Index,
// approvals, reminders) into ONE ranked, de-duplicated, de-noised list. DB-free;
// the route feeds it real Supabase rows.

export type CalmSource = 'agent' | 'autopilot' | 'operating_index' | 'approval' | 'reminder' | 'graph';
export type ItemSeverity = 'action' | 'attention' | 'info';

export type CalmItem = {
  id: string;
  source: CalmSource;
  title: string;
  detail?: string | null;
  href?: string | null;
  severity: ItemSeverity;
  /** ISO time this is relevant, if any — sooner sorts first. */
  at?: string | null;
};

export type CalmInbox = {
  /** One calm sentence summarizing the day. */
  digest: string;
  /** Only the truly urgent — gentle escalation. */
  needsYou: CalmItem[];
  /** Worth doing today, not alarming. */
  today: CalmItem[];
  /** Count of quieter/handled items deliberately kept out of the way. */
  quieted: number;
  /** Total items considered. */
  total: number;
};

const SEV_RANK: Record<ItemSeverity, number> = { action: 0, attention: 1, info: 2 };

/** Sort by severity, then soonest `at`, then title — deterministic. */
function rank(a: CalmItem, b: CalmItem): number {
  if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) return SEV_RANK[a.severity] - SEV_RANK[b.severity];
  const at = (a.at ?? '~'); const bt = (b.at ?? '~'); // nulls (~) sort last
  if (at !== bt) return at < bt ? -1 : 1;
  return a.title.localeCompare(b.title);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Build the one calm inbox. Dedupes near-identical titles (keeping the highest
 * severity), then splits into: needsYou (action only, capped), today (attention,
 * capped), and a `quieted` count for everything else (info + overflow) — so the
 * surface stays short and never nags.
 */
export function buildCalmInbox(items: CalmItem[], opts: { urgentCap?: number; todayCap?: number } = {}): CalmInbox {
  const urgentCap = opts.urgentCap ?? 5;
  const todayCap = opts.todayCap ?? 8;

  // Dedupe by normalized title, keeping the most severe instance.
  const byTitle = new Map<string, CalmItem>();
  for (const it of items) {
    const key = it.title.trim().toLowerCase();
    const prev = byTitle.get(key);
    if (!prev || SEV_RANK[it.severity] < SEV_RANK[prev.severity]) byTitle.set(key, it);
  }
  const deduped = [...byTitle.values()].sort(rank);
  const total = deduped.length;

  const action = deduped.filter((i) => i.severity === 'action');
  const attention = deduped.filter((i) => i.severity === 'attention');

  const needsYou = action.slice(0, urgentCap);
  const today = attention.slice(0, todayCap);
  const quieted = total - needsYou.length - today.length;

  return { digest: calmDigest(needsYou.length, today.length, quieted), needsYou, today, quieted, total };
}

/** The gentle one-line digest. Leads with calm when there's nothing urgent. */
export function calmDigest(needsYou: number, today: number, quieted: number): string {
  if (needsYou === 0 && today === 0) {
    return quieted > 0
      ? `You're all caught up. ${plural(quieted, 'quieter item')} ${quieted === 1 ? 'is' : 'are'} handled in the background.`
      : "You're all caught up — nothing needs you right now.";
  }
  const parts: string[] = [];
  if (needsYou > 0) parts.push(`${plural(needsYou, 'thing')} ${needsYou === 1 ? 'needs' : 'need'} you`);
  if (today > 0) parts.push(`${today} more for today`);
  let s = parts.join(', ') + '.';
  if (quieted > 0) s += ` Everything else (${quieted}) is handled.`;
  return s;
}

/** How many notifications this calm view SPARED the family vs. one-per-signal. */
export function noiseReduced(inbox: CalmInbox): number {
  return Math.max(0, inbox.total - inbox.needsYou.length - inbox.today.length);
}
