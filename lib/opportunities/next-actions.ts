// Next Best Actions — pure, unit-tested ranking that merges the family's
// upcoming events, open tasks, and time-boxed opportunities into ONE prioritized
// "do this next" list. The page maps each Supabase table into ActionInput; this
// module buckets by urgency and sorts, so "recommend next best actions" is real
// logic, not a vibe.

export type ActionSource = 'event' | 'task' | 'opportunity';
export type ActionPriority = 'low' | 'medium' | 'high';
export type ActionBucket = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'someday';

export type ActionInput = {
  id: string;
  source: ActionSource;
  title: string;
  /** Due/relevant day as YYYY-MM-DD, or null for undated ("someday"). */
  whenKey: string | null;
  priority?: ActionPriority;
  href: string;
};

export type NextAction = ActionInput & {
  bucket: ActionBucket;
  reason: string;
  score: number;
};

/** Whole days from `aKey` to `bKey` (YYYY-MM-DD), tz-safe via UTC parse. */
export function daysBetween(aKey: string, bKey: string): number {
  const a = Date.parse(`${aKey}T00:00:00Z`);
  const b = Date.parse(`${bKey}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const BUCKET_RANK: Record<ActionBucket, number> = {
  overdue: 0, today: 1, tomorrow: 2, this_week: 3, later: 4, someday: 5,
};
const PRIORITY_RANK: Record<ActionPriority, number> = { high: 0, medium: 1, low: 2 };

function bucketFor(whenKey: string | null, todayKey: string): ActionBucket {
  if (!whenKey) return 'someday';
  const d = daysBetween(todayKey, whenKey);
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d <= 7) return 'this_week';
  return 'later';
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function reasonFor(bucket: ActionBucket, whenKey: string | null, todayKey: string): string {
  switch (bucket) {
    case 'overdue': {
      const late = -daysBetween(todayKey, whenKey!);
      return late === 1 ? 'Overdue by 1 day' : `Overdue by ${late} days`;
    }
    case 'today': return 'Due today';
    case 'tomorrow': return 'Due tomorrow';
    case 'this_week': {
      const dow = new Date(`${whenKey}T00:00:00Z`).getUTCDay();
      return `Due ${WEEKDAY[dow]}`;
    }
    case 'later': return `Due ${whenKey}`;
    default: return 'No due date';
  }
}

/**
 * Rank actions: most urgent bucket first (overdue → someday); within a bucket,
 * higher priority first, then earlier date, then a stable source/title order.
 * Overdue high-priority items float to the very top.
 */
export function rankNextActions(inputs: ActionInput[], todayKey: string): NextAction[] {
  const enriched = inputs.map((a) => {
    const bucket = bucketFor(a.whenKey, todayKey);
    const pr = a.priority ?? 'medium';
    // Lower score = more important.
    const score = BUCKET_RANK[bucket] * 100 + PRIORITY_RANK[pr] * 10;
    return { ...a, bucket, reason: reasonFor(bucket, a.whenKey, todayKey), score };
  });

  return enriched.sort((x, y) => {
    if (x.score !== y.score) return x.score - y.score;
    // Earlier dated first (nulls last within a bucket — only 'someday' has nulls).
    if (x.whenKey && y.whenKey && x.whenKey !== y.whenKey) return x.whenKey < y.whenKey ? -1 : 1;
    if (x.source !== y.source) return x.source < y.source ? -1 : 1;
    return x.title.localeCompare(y.title);
  });
}

/** Count of items that need attention now (overdue or due today). */
export function attentionCount(actions: NextAction[]): number {
  return actions.filter((a) => a.bucket === 'overdue' || a.bucket === 'today').length;
}

export const BUCKET_LABELS: Record<ActionBucket, string> = {
  overdue: 'Overdue', today: 'Today', tomorrow: 'Tomorrow',
  this_week: 'This week', later: 'Later', someday: 'Someday',
};

/** The order buckets should render in. */
export const BUCKET_ORDER: ActionBucket[] = ['overdue', 'today', 'tomorrow', 'this_week', 'later', 'someday'];
