export const CAPTURE_TABLES = ['calendar_events', 'todo_items', 'bills', 'family_reminders'] as const;
export type CaptureTable = (typeof CAPTURE_TABLES)[number];
/** These are the registry's creation names; updates have the same resource links. */
export const CAPTURE_CREATE_TOOLS: Readonly<Record<string, CaptureTable>> = {
  'calendar.createEvent': 'calendar_events',
  'tasks.createTodo': 'todo_items',
  'reminders.create': 'family_reminders',
};
export const CAPTURE_WINDOW_DAYS = 7;
export type CaptureRecord = { id: string; familyId: string; table: CaptureTable; createdAt: string; feedId?: string | null; externalUid?: string | null };
export type CaptureToolProof = {
  familyId: string; toolName: string; state: string; actorKind: string;
  resourceTable: string | null; resourceId: string | null; verified: boolean; finishedAt: string | null;
};
export type CaptureFeed = { id: string; familyId: string };
export type AutomaticCaptureShare = {
  since: string; until: string; total: number; automatic: number; unknown: number;
  /** A minimum share: missing provenance never becomes a manual capture. */
  minimumPercent: number | null;
};

export function captureWindow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('Capture window is invalid');
  return { since: new Date(now.getTime() - CAPTURE_WINDOW_DAYS * 86_400_000).toISOString(), until: now.toISOString() };
}
const key = (familyId: string, table: string, id: string) => JSON.stringify([familyId, table, id]);

/** Count canonical records, never the inbox/planner/ledger rows that describe them. */
export function verifiedAutomaticCaptureShare(input: {
  familyId: string; records: CaptureRecord[]; tools: CaptureToolProof[]; feeds: CaptureFeed[]; now: Date;
}): AutomaticCaptureShare {
  const { since, until } = captureWindow(input.now);
  const start = Date.parse(since);
  const end = input.now.getTime();
  const records = new Map<string, CaptureRecord>();
  for (const row of input.records) {
    if (row.familyId !== input.familyId || !CAPTURE_TABLES.includes(row.table)) continue;
    const createdAt = Date.parse(row.createdAt);
    if (!row.id || !Number.isFinite(createdAt)) throw new Error('Capture record identity or date is unavailable');
    if (createdAt < start || createdAt > end) continue;
    records.set(key(row.familyId, row.table, row.id), row);
  }
  const feeds = new Set(input.feeds.filter((feed) => feed.familyId === input.familyId).map((feed) => feed.id));
  const automatic = new Set<string>();
  for (const row of records.values()) {
    if (row.table === 'calendar_events' && row.feedId && feeds.has(row.feedId) && row.externalUid?.trim()) {
      automatic.add(key(row.familyId, row.table, row.id));
    }
  }
  for (const proof of input.tools) {
    if (proof.familyId !== input.familyId || proof.state !== 'succeeded' || !proof.verified
      || !['ai', 'system'].includes(proof.actorKind) || !proof.resourceId) continue;
    const table = CAPTURE_CREATE_TOOLS[proof.toolName];
    if (!table || proof.resourceTable !== table) continue;
    const finished = Date.parse(proof.finishedAt ?? '');
    if (!Number.isFinite(finished) || finished > end) continue;
    const identity = key(proof.familyId, table, proof.resourceId);
    const record = records.get(identity);
    if (record && finished >= Date.parse(record.createdAt)) automatic.add(identity);
  }
  const total = records.size;
  return {
    since, until, total, automatic: automatic.size, unknown: total - automatic.size,
    // Round down so a displayed minimum never exceeds the measured fraction.
    minimumPercent: total ? Math.floor(automatic.size * 1000 / total) / 10 : null,
  };
}
