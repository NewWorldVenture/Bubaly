// The household trail — `public.audit_logs` rendered as lines a family reads.
//
// Distinct from `lib/activity/feed.ts`, which DERIVES a timeline by re-reading
// the domain tables at render time. This one reads rows that were APPENDED when
// each change committed, which is the difference that matters here: a derived
// feed can only show what still exists, so a deleted event leaves no trace of
// having been deleted, and a change nobody's table records is simply absent.
//
// It is also the trail that carries BOTH actors. `agent_activity` is Bubaly's
// own ledger by design and stays that way; this is where a person's change and
// the assistant's sit side by side, which is the only way "who changed what"
// answers the question for a household rather than for the assistant.
//
// Pure and dependency-free so the wording is unit-testable — server and client
// components cannot be rendered under this repo's vitest config.

/** The columns `/family/activity` selects. A subset of `audit_logs`. */
export type TrailRow = {
  id: string;
  action: string;
  resource: string;
  resource_id?: string | null;
  metadata?: unknown;
  created_at: string;
  actor_id: string | null;
};

export type TrailLine = {
  id: string;
  /** Who acted, already resolved to a name: a member's, or Bubaly. */
  who: string;
  /** What they did, in the service's own words where it left them. */
  what: string;
  at: string;
  /** True when Bubaly acted, so the surface can mark it without re-deriving. */
  byAssistant: boolean;
};

/**
 * Verbs the trail knows how to say, and the vocabulary a service may record.
 *
 * One definition for both halves on purpose: a service cannot write a verb this
 * cannot render, because `TrailAction` is derived from these keys. Rows written
 * by `lib/server/audit.ts` predate the vocabulary and carry free text like
 * `ai_run.cancel`; those are printed as written rather than dropped, since an
 * unknown verb is still a change that happened and hiding it would put a hole
 * back in the record this exists to close.
 */
export const TRAIL_VERBS = {
  create: 'created',
  update: 'updated',
  delete: 'removed',
  approve: 'approved',
  skip: 'skipped',
  send: 'sent',
  rsvp: 'replied to',
  confirm: 'confirmed',
  // One parent's yes on an approval that needs more than one: recorded, but
  // nothing was approved yet (lib/family/actions.ts resolveAutomationRun).
  vote: 'voted on',
} as const;

/**
 * The verbs a domain service may record against a committed write.
 *
 * There is deliberately no verb for reading. The trail is "a running log of
 * CHANGES across your household", and Bubaly reads far more than it writes — 40
 * of its tools are read-only — so admitting reads would bury every real change
 * under a list of things the assistant merely looked at. A call site with
 * nothing to record says so with `action: null`.
 */
export type TrailAction = keyof typeof TRAIL_VERBS;

/**
 * Whether the row says Bubaly acted.
 *
 * Asked directly rather than by narrowing `actor` to the union first: nothing
 * downstream uses the value itself, so a validating parse would be a guard no
 * test could distinguish from its absence. An unrecognised or missing actor
 * reads as "not the assistant", which is the safe direction — the trail would
 * rather under-credit Bubaly than claim a person's change for it.
 */
function byAssistantOf(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const actor = (metadata as { actor?: unknown }).actor;
  return actor === 'ai' || actor === 'system';
}

/** The human sentence the service recorded, when it recorded one. */
function titleOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const title = (metadata as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

/**
 * The server's ledger record of an account reopen (social_audit_logs, which no
 * member writes; lib/family/account-reopened.ts): the columns /family/activity
 * selects.
 */
export type ReopenRecordRow = { metadata?: unknown; created_at: string };

/**
 * Whether the row has the shape of the server's account-reopen entry: no
 * actor, action 'update', resource 'family', metadata.change 'reopened'
 * (lib/family/account-reopened.ts writes it with no actor and keeps the parent
 * who reopened, and the close it ended, in its metadata).
 *
 * A row with no actor is not, by that alone, the server's. A member's own row
 * must name the member when it is written (0380), but audit_logs.actor_id is
 * `references auth.users(id) on delete set null` (0002), so it ends with no
 * actor once that member's login is deleted (removeChildLoginAction deletes a
 * PIN child's; an erasure or a dashboard deletion anyone's). Read as the reopen on
 * any null-actor row, a child's row that named a parent there and a title of
 * the child's choosing became that parent's line once the child's login went
 * (household-roles N5-R1-NULL-ACTOR-TRAIL-ATTRIBUTION). Nor is the exact shape
 * enough: a member can write that too, and once their login goes it is this
 * row to the letter, so the shape is believed only beside a ledger record of
 * the same reopen (vouchedReopens, N6-R1-REOPEN-RESIDUAL-HAS-A-CODE-ONLY-LEDGER).
 */
function isReopenEntry(row: TrailRow): boolean {
  if (row.actor_id || row.action !== 'update' || row.resource !== 'family') return false;
  if (!row.metadata || typeof row.metadata !== 'object') return false;
  return (row.metadata as { change?: unknown }).change === 'reopened';
}

/** The parent and the close a reopen-shaped entry names, or null. */
function reopenOf(row: TrailRow): { reopenedBy: string; closedAt: string } | null {
  if (!isReopenEntry(row)) return null;
  const { reopened_by: reopenedBy, closed_at: closedAt } = row.metadata as { reopened_by?: unknown; closed_at?: unknown };
  return typeof reopenedBy === 'string' && reopenedBy && typeof closedAt === 'string' ? { reopenedBy, closedAt } : null;
}

/** How far apart the server's two records of one reopen may be dated: they are written one after the other. */
const REOPEN_RECORDS_APART_MS = 60_000;

/**
 * The trail's reopen entries the ledger vouches for. The server writes one of
 * each per reopen, in the same request, naming the same parent and the same
 * close, so each ledger record vouches for at most one entry: of those naming
 * its parent and close and dated within a minute of it, the nearest. A copy of
 * a real entry that a member planted beside it, or dated elsewhere, is not
 * credited too.
 */
function vouchedReopens(rows: TrailRow[], records: ReopenRecordRow[]): Set<string> {
  const vouched = new Set<string>();
  for (const record of records) {
    const meta = (record.metadata && typeof record.metadata === 'object' ? record.metadata : {}) as { reopened_by?: unknown; closed_at?: unknown };
    const at = Date.parse(record.created_at);
    let nearest: { id: string; gap: number } | null = null;
    for (const row of rows) {
      const reopen = vouched.has(row.id) ? null : reopenOf(row);
      if (!reopen || reopen.reopenedBy !== meta.reopened_by || reopen.closedAt !== meta.closed_at) continue;
      const gap = Math.abs(Date.parse(row.created_at) - at);
      if (gap <= REOPEN_RECORDS_APART_MS && gap < (nearest?.gap ?? Infinity)) nearest = { id: row.id, gap };
    }
    if (nearest) vouched.add(nearest.id);
  }
  return vouched;
}

/**
 * The person a row is by: its actor, or, on a reopen entry the ledger vouches
 * for, the parent the server recorded as reopening the account. Every other
 * row with no actor names no one ("Someone"), and a member who writes the key
 * on their own row is still the one named.
 */
function personOf(row: TrailRow, vouched: boolean): string | null {
  if (row.actor_id) return row.actor_id;
  return vouched ? reopenOf(row)?.reopenedBy ?? null : null;
}

/**
 * Turn one stored row into a line.
 *
 * `nameByUserId` maps `auth.users` ids to member display names; a row whose
 * actor is not in it reads "Someone" rather than showing a raw uuid, because a
 * former member's changes are still part of the household's history.
 */
export function describeTrailRow(row: TrailRow, nameByUserId: Map<string, string>, vouchedReopen = false): TrailLine {
  const byAssistant = byAssistantOf(row.metadata);
  const person = personOf(row, vouchedReopen);
  const named = person ? nameByUserId.get(person) : undefined;
  // The server writes no title on the reopen entry, so a line in that shape
  // says only what the server says ("updated family"): a title in it is
  // someone else's words.
  const title = isReopenEntry(row) ? null : titleOf(row.metadata);

  return {
    id: row.id,
    who: byAssistant ? 'Bubaly' : named ?? 'Someone',
    what: title ?? `${TRAIL_VERBS[row.action as TrailAction] ?? row.action} ${row.resource.replace(/_/g, ' ')}`,
    at: row.created_at,
    byAssistant,
  };
}

/**
 * The whole trail, newest first, in the order the rows arrived. `reopens` are
 * the ledger's reopen records (ReopenRecordRow); without them no reopen entry
 * is credited to a parent.
 */
export function describeTrail(rows: TrailRow[], nameByUserId: Map<string, string>, reopens: ReopenRecordRow[] = []): TrailLine[] {
  const vouched = vouchedReopens(rows, reopens);
  return rows.map((r) => describeTrailRow(r, nameByUserId, vouched.has(r.id)));
}
