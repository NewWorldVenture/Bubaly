import { z } from 'zod';

export const MAX_BRIEFING_RESPONSE_BYTES = 64 * 1024;
export const BRIEFING_RESPONSE_LIMITS = {
  text: 1000,
  label: 200,
  time: 40,
  icon: 32,
  listItems: 50,
  nestedItems: 20,
  categories: 10,
  age: 120,
  eventCount: 1000,
} as const;

const limits = BRIEFING_RESPONSE_LIMITS;
const text = z.string().max(limits.text);
const label = z.string().max(limits.label);
const icon = z.string().max(limits.icon);
const score = z.number().finite().min(0).max(100);
const conflict = z.object({ description: text, suggestion: text }).strict();
const reminder = z.object({
  text,
  urgency: z.enum(['high', 'medium', 'low']),
}).strict();

// Mirrors the briefing component's required, optional, and nullable fields.
// No model-controlled URL fields are part of this response contract.
export const BriefingResponseSchema = z.object({
  greeting: label,
  subtitle: label,
  familySummary: z.array(text).max(limits.listItems),
  schedule: z.array(z.object({
    time: z.string().max(limits.time),
    title: label,
    member: label,
    emoji: icon,
    color: z.enum(['blue', 'purple', 'rose', 'emerald', 'amber', 'cyan', 'indigo']),
  }).strict()).max(limits.listItems),
  conflicts: z.array(conflict).max(limits.listItems),
  kidsNeeds: z.array(z.object({
    name: label,
    age: z.number().int().min(0).max(limits.age).optional(),
    items: z.array(text).max(limits.nestedItems),
  }).strict()).max(limits.listItems),
  meals: z.array(z.object({
    meal: label,
    name: label.nullable(),
    // The component defines status as free text, not a closed enum.
    status: label,
    missing: z.array(label).max(limits.nestedItems).optional(),
  }).strict()).max(limits.listItems),
  reminders: z.array(reminder).max(limits.listItems),
  operationsScore: z.object({
    overall: score,
    categories: z.array(z.object({ label, score, icon }).strict()).max(limits.categories),
    stressLevel: z.enum(['low', 'moderate', 'high']),
    stressReason: text.nullable(),
    recommendation: text,
  }).strict(),
  completed: z.array(text).max(limits.listItems).optional(),
  outstanding: z.array(z.object({
    text,
    urgency: z.enum(['high', 'medium']),
  }).strict()).max(limits.listItems).optional(),
  tomorrowPreview: z.object({
    events: z.number().int().min(0).max(limits.eventCount),
    notes: z.array(text).max(limits.nestedItems),
  }).strict().optional(),
  weeklyHighlights: z.array(z.object({
    category: label,
    emoji: icon,
    items: z.array(text).max(limits.nestedItems),
  }).strict()).max(limits.listItems).optional(),
  weeklyConflicts: z.array(conflict).max(limits.listItems).optional(),
}).strict();

export type BriefingResponse = z.infer<typeof BriefingResponseSchema>;

// ─── Decisions ───────────────────────────────────────────────────────────────
//
// The decisions slice is NOT part of `BriefingResponseSchema` above, on
// purpose. That schema is the MODEL's contract — what a completion may say —
// and a decision is never the model's word: it is a pending `approval_requests`
// row, a run parked in `awaiting_approval` / `awaiting_context`, a pending
// `parent_approvals` row or a pending recommendation, read from the tables and
// mapped by the same pure code Home's "Needs you" list uses
// (`lib/home/needs-build.ts`). The shapes below validate that slice on the way
// into the client (`lib/briefing/cache-isolation.ts`) and are what
// `lib/briefing/build.ts` persists inside a brief.
//
// The shapes are strict and the collections bounded; the strings are not
// length-capped. The caps above exist to bound a MODEL's output. These are
// the family's own rows — an approval title, a run summary — and cutting the
// brief off because one summary ran long would fail the page over data the
// inbox renders in full.

/** A same-origin path. A decision deep-links into the app and nowhere else. */
const appPath = z.string().regex(/^\/(?!\/)/);

/** One decision — the `NeedItem` shape of `lib/home/needs-attention.ts`, pinned. */
export const BriefDecisionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  href: appPath,
  urgency: z.enum(['emergency', 'urgent', 'normal']),
  createdAt: z.string(),
  count: z.number().int().min(0).optional(),
}).strict();

export type BriefDecision = z.infer<typeof BriefDecisionSchema>;

/** The card the Approve / Edit / Decline buttons act on — `ApprovalCardData`, pinned. */
export const BriefApprovalCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  consequences: z.array(z.string()).max(limits.listItems),
  domain: z.string(),
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  expiresAt: z.string().nullable(),
  runId: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  canEdit: z.boolean(),
  editableFields: z.array(z.object({
    key: z.string(),
    label: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    type: z.enum(['text', 'number', 'boolean']),
  }).strict()).max(limits.listItems).optional(),
  agent: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  requiredApprovals: z.number().int().min(0).optional(),
  approvalsRecorded: z.number().int().min(0).optional(),
  parentsOnly: z.boolean().optional(),
}).strict();

/**
 * The decisions slice of the public briefing envelope. `items` is ranked and
 * capped; `approvals` carries the card data for `ai_approval` items so the
 * page can render the shared approval card; `moneyApprovalKinds` says which
 * wallet action an `approval` item's buttons run; `canDecide` is the viewer's
 * role, re-checked on the server by every action.
 */
export const BriefDecisionsSchema = z.object({
  items: z.array(BriefDecisionSchema).max(limits.listItems),
  approvals: z.record(z.string(), BriefApprovalCardSchema),
  moneyApprovalKinds: z.record(z.string(), z.string()),
  canDecide: z.boolean(),
}).strict();

export type BriefDecisions = z.infer<typeof BriefDecisionsSchema>;

/** Validate the entire bounded completion; never extract JSON from prose. */
export function parseBriefingResponse(raw: unknown): BriefingResponse | null {
  if (typeof raw !== 'string' || raw.length > MAX_BRIEFING_RESPONSE_BYTES) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_BRIEFING_RESPONSE_BYTES) return null;

  try {
    const value: unknown = JSON.parse(raw);
    const result = BriefingResponseSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    // Invalid output must not escape into the public response or its logs.
    return null;
  }
}
