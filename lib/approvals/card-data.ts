// What an approval row LOOKS LIKE to a person — pure, dependency-free, and
// shared by the server (the approvals service builds card data for Home and
// the inbox) and the client (the trust module maps the rows it was given).
//
// Why this is not inside `lib/services/approvals`: that module is
// `server-only`, and the trust page hands its rows to a client component. The
// classification of a payload and the choice of which fields a manager may
// edit must be ONE rule, or the Edit modal would offer fields the service then
// refuses. Keeping the rule here, importing only pure modules, lets both sides
// use it.
import type { WriteBackKind } from '@/lib/concierge/apply';
// Pure, and shared with the service that enforces it: the card must say what
// the engine will actually require, not a second opinion about it.
import { thresholdFor } from '@/lib/approvals/threshold';

/** A field a manager may change on the Edit path — scalars only, so the form stays honest. */
export type EditableField = {
  key: string;
  label: string;
  value: string | number | boolean;
  type: 'text' | 'number' | 'boolean';
};

/**
 * What the approval card renders. Deliberately no payload and no reasoning
 * chain: a parent decides on the title, the plain-language consequences and
 * the cost, never on JSON. `editableFields` is the scalar subset of the
 * payload the Edit modal may change.
 */
export type ApprovalCardData = {
  id: string;
  title: string;
  summary: string | null;
  consequences: string[];
  domain: string;
  requestedBy: string | null;
  requestedAt: string;
  expiresAt: string | null;
  runId: string | null;
  amountCents: number | null;
  canEdit: boolean;
  editableFields?: EditableField[];
  agent?: string | null;
  priority?: string | null;
  /**
   * How many approvals this needs under its model, and how many are in.
   * Optional because a card stored before these existed has neither; the
   * renderer treats a missing threshold as a plain single approval.
   */
  requiredApprovals?: number;
  approvalsRecorded?: number;
  /** True when only a parent's yes counts (the two-parent model). */
  parentsOnly?: boolean;
};

/**
 * The columns of `approval_requests` the card needs. A subset of the row type
 * so a page that selected `*` and a service that selected these both fit.
 */
export type TrustApproval = {
  id: string;
  domain: string;
  capability: string;
  requested_by_kind: string;
  requested_by_member_id: string | null;
  agent: string | null;
  title: string;
  summary: string | null;
  payload: unknown;
  payload_kind: string | null;
  amount_cents: number | null;
  confidence: number | null;
  reasoning: string | null;
  required_approvals: number;
  approval_model?: string | null;
  approvals: unknown;
  status: string;
  priority: string;
  created_at: string;
  expires_at: string | null;
  run_id: string | null;
  plan_step_id: string | null;
  plan_step_ids: string[] | null;
  consequences: unknown;
  edited_payload: unknown;
};

export type ClassifiedPayload =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'plan_steps'; runId: string | null; stepIds: string[]; input: Record<string, unknown> | null }
  | { kind: 'concierge_plan'; planId: string; kinds: WriteBackKind[] };

export const WRITE_BACK_KINDS: readonly WriteBackKind[] = ['calendar', 'reminder', 'task'];

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/**
 * Which of the three shapes a stored row is. The `payload_kind` column wins;
 * the legacy rows written before 0251 (`{name,args}` from the trust bridge,
 * `{plan_id,kinds}` from the concierge loop) are recognised by shape so they
 * keep executing. Anything else is refused rather than guessed — an approval
 * whose payload nobody can interpret must not be reported as "done".
 */
export function classifyPayload(
  row: Pick<TrustApproval, 'payload' | 'payload_kind' | 'run_id' | 'plan_step_ids' | 'plan_step_id'>,
): ClassifiedPayload | null {
  const payload = asRecord(row.payload) ?? {};
  const declared = row.payload_kind ?? (typeof payload.kind === 'string' ? payload.kind : null);

  const asTool = (): ClassifiedPayload | null => {
    if (typeof payload.name !== 'string' || !payload.name.trim()) return null;
    return { kind: 'tool', name: payload.name.trim(), args: asRecord(payload.args) ?? {} };
  };
  const asPlanSteps = (): ClassifiedPayload | null => {
    const fromPayload = stringList(payload.step_ids);
    const fromColumns = [...(row.plan_step_ids ?? []), ...(row.plan_step_id ? [row.plan_step_id] : [])];
    const stepIds = [...new Set([...fromPayload, ...fromColumns])];
    if (stepIds.length === 0) return null;
    const runId = typeof payload.run_id === 'string' ? payload.run_id : row.run_id;
    return { kind: 'plan_steps', runId: runId ?? null, stepIds, input: asRecord(payload.input) };
  };
  const asConcierge = (): ClassifiedPayload | null => {
    if (typeof payload.plan_id !== 'string' || !payload.plan_id) return null;
    const kinds = stringList(payload.kinds).filter((k): k is WriteBackKind => (WRITE_BACK_KINDS as readonly string[]).includes(k));
    return { kind: 'concierge_plan', planId: payload.plan_id, kinds: kinds.length ? kinds : [...WRITE_BACK_KINDS] };
  };

  switch (declared) {
    case 'tool': return asTool();
    case 'plan_steps': return asPlanSteps();
    case 'concierge_plan': return asConcierge();
    default: return asTool() ?? asConcierge() ?? asPlanSteps();
  }
}

/** Keys that are identity or bookkeeping, never something a person should retype. */
const NON_EDITABLE_KEYS = new Set(['id', 'family_id', 'run_id', 'step_ids', 'plan_id', 'kind', 'consequences', 'summary']);

function humanLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** The scalar fields of an argument object, in a form a small modal can render. */
export function editableFieldsFor(args: Record<string, unknown> | null | undefined): EditableField[] {
  if (!args) return [];
  const fields: EditableField[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (NON_EDITABLE_KEYS.has(key)) continue;
    if (typeof value === 'string') fields.push({ key, label: humanLabel(key), value, type: 'text' });
    else if (typeof value === 'number' && Number.isFinite(value)) fields.push({ key, label: humanLabel(key), value, type: 'number' });
    else if (typeof value === 'boolean') fields.push({ key, label: humanLabel(key), value, type: 'boolean' });
  }
  return fields;
}

/** The editable part of each payload kind: tool args, the step's input, or the concierge kinds. */
export function editableArgsOf(classified: ClassifiedPayload | null): Record<string, unknown> | null {
  if (!classified) return null;
  switch (classified.kind) {
    case 'tool': return classified.args;
    case 'plan_steps': return classified.input;
    case 'concierge_plan':
      return Object.fromEntries(WRITE_BACK_KINDS.map((k) => [k, classified.kinds.includes(k)]));
  }
}

export function consequencesOf(row: Pick<TrustApproval, 'consequences'>): string[] {
  return stringList(row.consequences).map((c) => c.trim()).filter(Boolean).slice(0, 8);
}

/**
 * Card data for one row. `requestedBy` is resolved by the caller (a member's
 * name, or null) — an AI request is always shown as "Bubaly".
 */
export function toApprovalCardData(
  row: TrustApproval,
  opts: { requestedBy: string | null; canEdit: boolean; managerCount?: number },
): ApprovalCardData {
  const classified = classifyPayload(row);
  const editableFields = editableFieldsFor(editableArgsOf(classified));
  // What the request is waiting for is part of the request. Before this, a
  // parent tapping Approve on a two-parent row learned it needed a second yes
  // only from the toast that came back.
  const threshold = thresholdFor(row.approval_model, row.required_approvals, opts.managerCount ?? 1);
  const votes = Array.isArray(row.approvals) ? (row.approvals as Record<string, unknown>[]) : [];
  const recorded = votes.filter((v) => v?.decision === 'approved' && (!threshold.parentsOnly || v?.role === 'parent')).length;
  return {
    requiredApprovals: threshold.required,
    approvalsRecorded: recorded,
    parentsOnly: threshold.parentsOnly,
    id: row.id,
    title: row.title,
    summary: row.summary,
    consequences: consequencesOf(row),
    domain: row.domain,
    requestedBy: row.requested_by_kind === 'ai' ? 'Bubaly' : opts.requestedBy,
    requestedAt: row.created_at,
    expiresAt: row.expires_at,
    runId: row.run_id,
    amountCents: row.amount_cents,
    canEdit: opts.canEdit && editableFields.length > 0,
    editableFields,
    agent: row.agent,
    priority: row.priority,
  };
}
