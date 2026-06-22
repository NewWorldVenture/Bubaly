// Pure activity-feed merge logic — unit tested, no dependencies.
// The feed is derived at read time from existing family tables; nothing is
// written. Each source contributes ActivityItems which are merged + sorted.

export type ActivityKind = 'announcement' | 'event' | 'chore' | 'photo' | 'note' | 'grocery';

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  text: string;
  /** ISO timestamp the activity happened at. */
  at: string;
  /** Family member id, when the actor is known as a member. */
  memberId?: string | null;
  /** Auth user id, when the actor is only known by user id. */
  userId?: string | null;
};

/** Merge any number of source item arrays into one newest-first timeline. */
export function mergeActivity(sources: ActivityItem[][], limit = 50): ActivityItem[] {
  const all = sources.flat().filter((i) => i && i.at);
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all.slice(0, limit);
}

/** Human "2h ago" style relative time, stable and dependency-free. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now.getTime() - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
