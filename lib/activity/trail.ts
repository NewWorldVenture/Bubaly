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
 * Turn one stored row into a line.
 *
 * `nameByUserId` maps `auth.users` ids to member display names; a row whose
 * actor is not in it reads "Someone" rather than showing a raw uuid, because a
 * former member's changes are still part of the household's history.
 */
export function describeTrailRow(row: TrailRow, nameByUserId: Map<string, string>): TrailLine {
  const byAssistant = byAssistantOf(row.metadata);
  const named = row.actor_id ? nameByUserId.get(row.actor_id) : undefined;

  return {
    id: row.id,
    who: byAssistant ? 'Bubaly' : named ?? 'Someone',
    what: titleOf(row.metadata) ?? `${TRAIL_VERBS[row.action as TrailAction] ?? row.action} ${row.resource.replace(/_/g, ' ')}`,
    at: row.created_at,
    byAssistant,
  };
}

/** The whole trail, newest first, in the order the rows arrived. */
export function describeTrail(rows: TrailRow[], nameByUserId: Map<string, string>): TrailLine[] {
  return rows.map((r) => describeTrailRow(r, nameByUserId));
}
