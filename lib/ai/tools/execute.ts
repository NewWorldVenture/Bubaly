// The single choke point every AI write goes through.
//
// ORDER IS THE DESIGN. Each step exists to make a specific failure impossible:
//
//   1. Look the tool up. An unknown name is DENIED, never a silent no-op —
//      a hallucinated `finances.transferMoney` must read as a refusal in the
//      transcript, not as nothing happening (§43 default deny).
//   2. Parse the arguments with the tool's zod schema. Invalid arguments end
//      the call before a single query runs, so a malformed model reply can
//      never leave a half-written row behind.
//   3. Trust. Writes are evaluated as `automate` for AI and system actors —
//      every `subject_kind='ai'` policy (the autopilot dial, §4.6's category
//      policies) is written against `automate`, and evaluating a write as
//      `create` would fall through to ROLE_DEFAULTS where parents may do
//      everything and "Recommend only" would not block a thing. The risk tier
//      (§12) is applied after the family's own policies and grants, so a
//      household's explicit decision always wins.
//   4. Idempotency. `ai_tool_calls` is reserved under a deterministic key
//      before execution; a retried run finds the earlier row and returns its
//      result instead of creating a fifth soccer practice.
//   5. Execute, validate the output, record the ledger row and (for writes)
//      the family-visible activity line.
//   6. Verify. §13: execution is not success. The verdict rides along on the
//      outcome rather than turning a committed write back into a failure.
//
// WHY THE LEDGER USES THE SERVICE CLIENT: migration 0250 gives members SELECT
// on `ai_tool_calls` and no write policy at all, precisely so a family member
// cannot forge or erase the record of what the AI did. Server code writes it
// with `createServiceClient()` and filters `family_id` itself.
//
// WHAT IS DELIBERATELY *NOT* LEDGERED: read-only tools (nothing to
// deduplicate, nothing to undo — the audit value does not justify storing a
// copy of every list the model read), and denied or pending-approval calls.
// A reserved key for a call that never executed would block the approved
// retry from running; those paths are recorded in `trust_audit_logs` and
// `approval_requests`, which is where a reviewer looks for them.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TrailAction } from '@/lib/activity/trail';
import { conformNulls } from '@/lib/ai/schema-to-json';
import type { Database, Json } from '@/lib/database.types';
import { recordActivity } from '@/lib/services/activity';
import { makeKey, scopeKey } from '@/lib/services/idempotency';
import type { ServiceScope } from '@/lib/services/types';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError, describeDbError } from '@/lib/supabase/errors';
import {
  HIGH_STAKES_AI_DOMAINS, riskToDecision,
  type Capability, type Decision, type TrustRole,
} from '@/lib/trust/engine';
import { approvalDedupeKey, evaluateTrust, roleOf } from '@/lib/trust/server';
import { behaviorForDomain, effectiveRisk } from '@/lib/ai/family-settings';
import { getAISettings } from '@/lib/services/ai-settings';
import { getTool } from './registry';
import type { ToolDefinition, ToolOutcome } from './types';

type DB = SupabaseClient<Database>;

/** A reservation older than this is assumed abandoned (0250's documented semantics). */
const STALE_RESERVATION_MS = 2 * 60_000;

/**
 * The trail verb for a tool, from what the tool already declares about itself.
 *
 * Read-only tools get `null`: Bubaly reads far more than it writes, and the
 * household trail is a log of CHANGES — 40 read tools would bury every real one.
 * `automate` has no honest mapping (`routines.create` and `routines.pause`
 * share it), so such a tool must declare `trailAction`; one that does not
 * records no trail row rather than a wrong verb, and
 * `tests/household-trail.test.ts` fails on any write tool in that state.
 */
export function trailActionFor(tool: Pick<ToolDefinition, 'readOnly' | 'capability' | 'trailAction'>): TrailAction | null {
  if (tool.readOnly) return null;
  if (tool.trailAction) return tool.trailAction;
  const fromCapability: Partial<Record<Capability, TrailAction>> = { create: 'create', edit: 'update', delete: 'delete' };
  return fromCapability[tool.capability] ?? null;
}

/** Deep links used for the activity feed, per trust domain. */
const DOMAIN_HREF: Record<string, string> = {
  calendar: '/dashboard/calendar',
  scheduling: '/dashboard/reminders',
  tasks: '/dashboard/todos',
  chores: '/dashboard/chores',
  shopping: '/dashboard/grocery',
  messaging: '/dashboard/notifications',
};

export type ExecuteToolOptions = {
  runId?: string | null;
  stepId?: string | null;
  requestId?: string | null;
  /** Planner/extraction confidence, fed to policy conditions like `minConfidence`. */
  confidence?: number;
  idempotencyKey?: string | null;
  /**
   * Skip the trust gate. The ONLY legitimate caller is the run executor
   * replaying a step whose `approval_requests` row is already approved: the
   * approval was the gate, and re-evaluating it would open a second approval
   * row for work a parent has already said yes to.
   */
  skipTrust?: boolean;
};

/** `role` is the requester's, re-read at claim time by the executor; a pure cron has none. */
function trustRoleFor(role: ServiceScope['role']): TrustRole {
  // A cron or the run executor with no human behind it is still doing the
  // household's own work, so it is evaluated as the least-privileged role that
  // can act at all — `adult`. That keeps banking, passports, emergency and
  // every HIGH_STAKES domain behind approval while letting routine calendar
  // and task work run unattended, and it never inherits a parent's authority.
  if (role === 'system') return 'adult';
  return roleOf(role);
}

/** The first sentence of a description, for approval titles. */
function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return (match?.[1] ?? text.trim()).replace(/[.]$/, '');
}

/** Pick the label a person would recognise out of the arguments. */
function argLabel(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['title', 'task', 'item', 'name', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function approvalTitle(tool: ToolDefinition, input: unknown): string {
  const label = argLabel(input);
  return label ? `${firstSentence(tool.description)} — "${label}"` : firstSentence(tool.description);
}

function issueSummary(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : 'input'}: ${issue.message}`)
    .join('; ');
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505');
}

/**
 * The client the ledger is written with.
 *
 * Not cached: constructing it is cheap next to the round trips it makes, and a
 * cached instance would outlive a configuration change. A deployment missing
 * the service-role key gets an honest failure at the first write rather than a
 * silently unaudited one.
 */
function ledgerClient(): DB | null {
  try {
    return createServiceClient();
  } catch (error) {
    console.error('[tool-exec] service client unavailable — no tool call can be recorded', error);
    return null;
  }
}

/**
 * The key two calls must share to count as the same call.
 *
 * A caller-supplied key wins outright (the chat route derives one from the
 * originating message). Otherwise the key is only ever composed INSIDE a
 * run/request context, and that is the whole point: a retried step, a
 * double-submitted request or two steps of one plan that both want the same
 * soccer practice collapse to one write, while "add milk" typed again on a
 * later turn is a different context, a different key, and a second carton of
 * milk — which is what the person meant. A bare chat call therefore gets a
 * unique key: nothing is deduplicated, and the ledger row still exists for the
 * audit.
 *
 * Within a context, the tool's own natural key (title + time, the shape of the
 * thing being created) beats the argument hash, because two steps can ask for
 * the same event with differently-spelled arguments.
 */
function resolveIdempotencyKey(scope: ServiceScope, tool: ToolDefinition, input: unknown, opts: ExecuteToolOptions): string {
  const supplied = opts.idempotencyKey ?? scope.idempotencyKey ?? null;
  if (supplied) return supplied;

  if (scope.runId || scope.stepId || scope.requestId) {
    const natural = tool.idempotencyFrom?.(input, scope) ?? null;
    // Deliberately keyed by the run/request and NOT the step: the duplicate a
    // plan actually produces is two steps creating the same thing.
    if (natural) return makeKey([scope.familyId, scope.runId ?? scope.requestId ?? null, tool.name, natural]);
    return scopeKey(scope, tool.name, input);
  }
  return makeKey([scope.familyId, tool.name, 'once', crypto.randomUUID()]);
}

type Reservation =
  | { status: 'reserved'; id: string }
  | { status: 'duplicate'; id: string; outputs: Json | null }
  | { status: 'in_progress' }
  | { status: 'error'; error: string };

async function reserveCall(
  ledger: DB,
  scope: ServiceScope,
  tool: ToolDefinition,
  key: string,
  input: unknown,
): Promise<Reservation> {
  const nowIso = new Date().toISOString();
  const row = {
    family_id: scope.familyId,
    run_id: scope.runId ?? null,
    plan_step_id: scope.stepId ?? null,
    request_id: scope.requestId ?? null,
    tool_name: tool.name,
    requested_by: scope.userId,
    requested_by_member_id: scope.memberId,
    actor_kind: scope.actorKind,
    inputs: (input ?? {}) as Json,
    state: 'reserved' as const,
    attempt: 1,
    locked_at: nowIso,
    idempotency_key: key,
  };

  const { data, error } = await ledger.from('ai_tool_calls').insert(row).select('id').single();
  if (!error && data) return { status: 'reserved', id: data.id };

  if (!isUniqueViolation(error)) {
    console.error('[tool-exec] could not reserve a tool call', error);
    return { status: 'error', error: describeDbError(error, 'Bubaly could not record that action, so it did not run.') };
  }

  // Someone already holds this key. 0250's semantics decide what that means.
  const { data: existing, error: readError } = await ledger
    .from('ai_tool_calls')
    .select('id, state, attempt, locked_at, outputs')
    .eq('family_id', scope.familyId)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (readError || !existing) {
    console.error('[tool-exec] could not read the conflicting tool call', readError);
    return { status: 'error', error: describeDbError(readError, 'Bubaly could not confirm whether that already happened.') };
  }

  if (existing.state === 'succeeded') return { status: 'duplicate', id: existing.id, outputs: existing.outputs };

  const lockedAt = existing.locked_at ? Date.parse(existing.locked_at) : Number.NaN;
  const stale = !Number.isFinite(lockedAt) || Date.now() - lockedAt > STALE_RESERVATION_MS;
  if (existing.state !== 'failed' && !stale) return { status: 'in_progress' };

  // Take the row over. The `state` guard makes the takeover atomic against a
  // second worker doing the same thing: exactly one update matches.
  const { data: taken, error: takeError } = await ledger
    .from('ai_tool_calls')
    .update({ state: 'reserved', attempt: existing.attempt + 1, locked_at: nowIso, error: null, outputs: null, finished_at: null })
    .eq('id', existing.id)
    .eq('state', existing.state)
    .select('id')
    .maybeSingle();
  if (takeError) {
    console.error('[tool-exec] could not take over a stale tool call', takeError);
    return { status: 'error', error: describeDbError(takeError, 'Bubaly could not record that action, so it did not run.') };
  }
  if (!taken) return { status: 'in_progress' };
  return { status: 'reserved', id: taken.id };
}

/** Close out a ledger row. Never throws: the household write already happened. */
async function finalizeCall(
  ledger: DB,
  toolCallId: string,
  patch: { state: 'succeeded' | 'failed'; outputs?: Json | null; error?: string | null; durationMs: number; resource?: { table: string; id: string | null } | null },
): Promise<void> {
  const { error } = await ledger
    .from('ai_tool_calls')
    .update({
      state: patch.state,
      outputs: patch.outputs ?? null,
      error: patch.error ?? null,
      duration_ms: patch.durationMs,
      finished_at: new Date().toISOString(),
      resource_table: patch.resource?.table ?? null,
      resource_id: patch.resource?.id ?? null,
    })
    .eq('id', toolCallId);
  if (error) console.error('[tool-exec] could not finalize the tool call ledger row', error);
}

type Gate =
  | { kind: 'allow' }
  | { kind: 'denied'; reason: string }
  | { kind: 'pending'; approvalId: string | null; summary: string };

/**
 * Everything between "the arguments are valid" and "the service may run".
 *
 * Read-only tools skip the gate unless their domain is one where a read is
 * itself sensitive (finances, medical, documents…), in which case they are
 * evaluated as `view` and the view-sensitivity rule in `riskToDecision`
 * applies. No read tool is in such a domain today; the guard is live so that
 * the first one that arrives is gated by construction rather than by someone
 * remembering.
 */
async function gate(
  scope: ServiceScope,
  tool: ToolDefinition,
  input: unknown,
  opts: ExecuteToolOptions,
): Promise<Gate> {
  if (opts.skipTrust) return { kind: 'allow' };
  if (tool.readOnly && !HIGH_STAKES_AI_DOMAINS.includes(tool.domain)) return { kind: 'allow' };

  const actorKind = scope.actorKind === 'member' ? 'member' : 'ai_agent';
  const role = trustRoleFor(scope.role);
  const actorId = actorKind === 'member' ? (scope.memberId ?? scope.userId ?? 'unknown') : 'bubaly';
  const capability: Capability = actorKind === 'ai_agent' && !tool.readOnly ? 'automate' : tool.capability;
  const confidence = opts.confidence ?? 0.85;
  const title = approvalTitle(tool, input);
  const consequences = tool.consequences?.(input) ?? [];

  // What this household said Bubaly may do (0257). `getAISettings` answers the
  // cautious defaults rather than failing, so a settings problem can only
  // tighten the gate, never open it.
  const settings = await getAISettings(scope);
  const risk = effectiveRisk(settings, tool);
  const behavior = behaviorForDomain(settings, tool.domain);
  if (!settings.enabled && actorKind === 'ai_agent' && !tool.readOnly) {
    // Switched off means switched off: no approval is opened, because there is
    // nothing for a parent to release — the family turned Bubaly's hands off.
    return { kind: 'denied', reason: 'Bubaly is switched off for this family in Settings → Bubaly AI.' };
  }

  const { decision: engineDecision, approvalId: engineApprovalId } = await evaluateTrust(scope.db, scope.familyId, {
    actor: { kind: actorKind, id: actorId, role },
    domain: tool.domain,
    capability,
    agent: 'Bubaly',
    title,
    summary: consequences[0] ?? tool.description,
    // Stored so an approved request can execute later without the model.
    payload: { name: tool.name, args: input as Record<string, unknown> },
    context: {
      confidence,
      tags: [`op:${tool.capability}`, `risk:${risk}`, `domain:${tool.domain}`],
    },
  });

  let decision: Decision = engineDecision;
  let approvalId = engineApprovalId ?? null;

  // The risk tier speaks where the answer came from the generic role matrix —
  // a household's own grant, delegation or emergency elevation is a deliberate
  // decision about this action and keeps the floor.
  //
  // A POLICY is only such a decision when it names the area it is talking
  // about. "Bubaly may act on the calendar" is a family's real choice and still
  // wins. A row saved with domain `all` and effect `allow` names nothing — and
  // the Trust form lets any manager save one, after which every `high` tool
  // (spend money, submit an order, delete records, share a document) executed
  // with nobody asked. So a blanket allow is re-checked against the tier and
  // may be tightened, never loosened.
  const fromGenericRule = decision.basis === 'role_default' || decision.basis === 'fallback';
  const blanketAllow = decision.basis === 'policy' && decision.effect === 'allow' && decision.policyScope === 'broad';
  if (fromGenericRule || blanketAllow) {
    const risked = riskToDecision({
      // The family's own override, floored for money and documents.
      risk,
      actor: { kind: actorKind, id: actorId, role },
      domain: tool.domain,
      capability,
      behavior,
      explicitAllow: false,
    });
    // Safety rail: a tier must never release work that already has an approval
    // waiting on a person. (`riskToDecision` cannot produce that today; this
    // keeps it true if its rules are ever widened.)
    const usable = risked && !(approvalId && risked.effect === 'allow');
    // Over a blanket allow the tier may only tighten: an `allow` from the tier
    // would be no change, and letting it through would rewrite the basis.
    if (usable && (fromGenericRule || risked!.effect !== 'allow')) decision = risked!;
  }

  if (decision.basis === 'risk_tier') {
    if (decision.effect === 'require_approval' && !approvalId) {
      approvalId = await openApproval(scope, tool, input, decision, { title, consequences, confidence, capability, actorKind, actorId });
    }
    await recordRiskAudit(scope, tool, decision, approvalId, { confidence, capability, actorKind, actorId });
  } else if (approvalId && consequences.length > 0) {
    // The trust bridge opens approvals without knowing what the tool would do;
    // the card (§31) needs the consequences, so they are attached here.
    const { error } = await (await trustWriter(scope)).from('approval_requests').update({ consequences: consequences as unknown as Json }).eq('id', approvalId).eq('family_id', scope.familyId);
    if (error) console.error('[tool-exec] could not attach consequences to the approval', error);
  }

  if (decision.effect === 'deny') return { kind: 'denied', reason: decision.reason };
  if (decision.effect === 'require_approval') {
    return {
      kind: 'pending',
      approvalId,
      summary: `${title} — waiting for a parent to approve. ${decision.reason}`,
    };
  }
  return { kind: 'allow' };
}

type GateMeta = {
  title?: string;
  consequences?: string[];
  confidence: number;
  capability: Capability;
  actorKind: 'member' | 'ai_agent';
  actorId: string;
};

/**
 * Open the approval row for a decision the RISK TIER reached.
 *
 * `evaluateTrust` opens one only for decisions the pure engine reached, and
 * the tier is applied after it — so this is the one path that has to write the
 * row itself. It uses the same columns plus the two the bridge cannot know
 * about (`payload_kind`, `consequences`), so both kinds of approval render and
 * execute identically.
 */
/**
 * The client that files approval requests and audit rows on Bubaly's behalf.
 * 0252 lets a member INSERT only their own member-kind approval row, so the
 * AI-filed rows this module writes must go through the service client; a
 * system scope already holds it, and when no service credentials exist (unit
 * tests) the caller's client is used, which is what the recorder tests see.
 */
async function trustWriter(scope: ServiceScope): Promise<ServiceScope['db']> {
  if (scope.actorKind === 'system') return scope.db;
  try {
    const { createServiceClient } = await import('@/lib/supabase/server');
    return createServiceClient();
  } catch {
    return scope.db;
  }
}

async function openApproval(
  scope: ServiceScope,
  tool: ToolDefinition,
  input: unknown,
  decision: Decision,
  meta: GateMeta,
): Promise<string | null> {
  const writer = await trustWriter(scope);
  // The SECOND filer of approval_requests. `openApprovalRequest` (lib/trust/
  // server.ts) is the other, and 0273 deduped it — but this one opens a row when
  // the RISK TIER tightened an `allow` the engine had already permitted, so
  // without the same key a resend on that path still files two identical cards.
  // The key is computed by the same function on purpose: one definition of what
  // makes two requests the same action.
  const dedupeKey = approvalDedupeKey(scope.familyId, {
    actor: { kind: meta.actorKind, id: meta.actorId, role: roleOf(scope.role) },
    domain: tool.domain,
    capability: meta.capability,
    agent: meta.actorKind === 'ai_agent' ? 'Bubaly' : undefined,
    onBehalfOfMemberId: scope.memberId,
    payload: { name: tool.name, args: input as Record<string, unknown> },
  });

  const existing = await writer.from('approval_requests')
    .select('id').eq('family_id', scope.familyId).eq('dedupe_key', dedupeKey).eq('status', 'pending')
    .limit(1).maybeSingle();
  if (existing.data?.id) return existing.data.id;

  const { data, error } = await writer
    .from('approval_requests')
    .insert({
      family_id: scope.familyId,
      domain: tool.domain,
      capability: meta.capability,
      requested_by_kind: meta.actorKind === 'ai_agent' ? 'ai' : 'member',
      requested_by_member_id: scope.memberId,
      agent: meta.actorKind === 'ai_agent' ? 'Bubaly' : null,
      title: meta.title ?? tool.name,
      summary: meta.consequences?.[0] ?? tool.description,
      payload: { name: tool.name, args: input as Record<string, unknown> } as unknown as Json,
      payload_kind: 'tool',
      consequences: (meta.consequences ?? []) as unknown as Json,
      confidence: meta.confidence,
      reasoning: decision.reason,
      approval_model: decision.approvalModel ?? 'single',
      required_approvals: decision.requiredApprovals ?? 1,
      status: 'pending',
      dedupe_key: dedupeKey,
    })
    .select('id')
    .single();
  if (data?.id) return data.id;
  // 23505: a concurrent resend won between the lookup and the insert. Its row is
  // the answer — returning null here would park the step on an approval that
  // exists, reported as one that could not be opened.
  if (error?.code === '23505') {
    const raced = await writer.from('approval_requests')
      .select('id').eq('family_id', scope.familyId).eq('dedupe_key', dedupeKey).eq('status', 'pending')
      .limit(1).maybeSingle();
    if (raced.data?.id) return raced.data.id;
  }
  console.error('[tool-exec] could not open an approval request', error);
  return null;
}

/**
 * The tier's own audit line. `evaluateTrust` already wrote the engine's
 * decision; this records that the risk tier changed it, and to what, so the
 * "why did Bubaly ask?" answer is complete rather than contradicted by the
 * earlier row.
 */
async function recordRiskAudit(
  scope: ServiceScope,
  tool: ToolDefinition,
  decision: Decision,
  approvalId: string | null,
  meta: GateMeta,
): Promise<void> {
  const { error } = await (await trustWriter(scope)).from('trust_audit_logs').insert({
    family_id: scope.familyId,
    actor_kind: meta.actorKind,
    actor_id: meta.actorId,
    domain: tool.domain,
    capability: meta.capability,
    decision: decision.effect,
    reason: decision.reason,
    confidence: meta.confidence,
    approval_id: approvalId,
    context: { basis: 'risk_tier', risk: tool.risk, tool: tool.name } as unknown as Json,
  });
  if (error) console.error('[tool-exec] could not record the risk-tier audit row', error);
}

/**
 * Run one tool for one family.
 *
 * Never throws: every failure — unknown tool, bad arguments, a denied policy, a
 * database error inside the service — comes back as a `ToolOutcome` the caller
 * can put in front of a person.
 */
export async function executeTool(
  scope: ServiceScope,
  name: string,
  rawArgs: unknown,
  opts: ExecuteToolOptions = {},
): Promise<ToolOutcome> {
  // ── 1. Look it up ─────────────────────────────────────────────────────────
  const tool = getTool(name);
  if (!tool) {
    console.error(`[tool-exec] unknown tool "${name}" requested`);
    return { status: 'denied', reason: `Bubaly has no tool called "${name}", so nothing was done.`, toolCallId: null };
  }

  const callScope: ServiceScope = {
    ...scope,
    runId: opts.runId ?? scope.runId ?? null,
    stepId: opts.stepId ?? scope.stepId ?? null,
    requestId: opts.requestId ?? scope.requestId ?? null,
    idempotencyKey: opts.idempotencyKey ?? scope.idempotencyKey ?? null,
  };

  // ── 2. Validate the arguments (nothing has touched the database yet) ──────
  const parsed = tool.input.safeParse(conformNulls(tool.input, rawArgs));
  if (!parsed.success) {
    return {
      status: 'error',
      error: `${tool.name} was called with arguments it cannot use — ${issueSummary(parsed.error)}.`,
      retryable: false,
      toolCallId: null,
    };
  }
  const input = parsed.data;

  // ── 3. Trust ─────────────────────────────────────────────────────────────
  let gated: Gate;
  try {
    gated = await gate(callScope, tool, input, opts);
  } catch (error) {
    // The gate is the safety boundary: if it cannot be evaluated, nothing runs.
    console.error(`[tool-exec] trust evaluation failed for ${tool.name}`, error);
    return {
      status: 'error',
      error: describeActionError(error, 'Bubaly could not check whether it was allowed to do that, so it did nothing.'),
      retryable: true,
      toolCallId: null,
    };
  }
  if (gated.kind === 'denied') return { status: 'denied', reason: gated.reason, toolCallId: null };
  if (gated.kind === 'pending') {
    return { status: 'pending_approval', approvalId: gated.approvalId, summary: gated.summary, toolCallId: null };
  }

  // ── Read-only tools: no ledger, no activity, no duplicate guard ───────────
  if (tool.readOnly) {
    const result = await runService(callScope, tool, input);
    if (!result.ok) return { status: 'error', error: result.error, retryable: result.retryable ?? false, toolCallId: null };
    const validated = tool.output.safeParse(result.data);
    if (!validated.success) {
      console.error(`[tool-exec] ${tool.name} returned an unexpected shape`, validated.error.issues);
      return { status: 'error', error: `${tool.name} returned something Bubaly could not read.`, retryable: false, toolCallId: null };
    }
    return { status: 'ok', data: validated.data, summary: tool.summarize(input, validated.data), toolCallId: null };
  }

  // ── 4. Idempotency ───────────────────────────────────────────────────────
  const ledger = ledgerClient();
  if (!ledger) {
    return {
      status: 'error',
      error: 'Bubaly cannot record what it does right now, so it did not make that change.',
      retryable: true,
      toolCallId: null,
    };
  }

  const key = resolveIdempotencyKey(callScope, tool, input, opts);
  const reservation = await reserveCall(ledger, callScope, tool, key, input);
  if (reservation.status === 'error') {
    return { status: 'error', error: reservation.error, retryable: true, toolCallId: null };
  }
  if (reservation.status === 'in_progress') {
    return {
      status: 'error',
      error: 'Bubaly is already doing that — give it a moment rather than asking twice.',
      retryable: true,
      toolCallId: null,
    };
  }
  if (reservation.status === 'duplicate') {
    return replayDuplicate(tool, input, reservation.id, reservation.outputs);
  }

  // ── 5. Execute ───────────────────────────────────────────────────────────
  const startedAt = Date.now();
  const result = await runService(callScope, tool, input);
  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    await finalizeCall(ledger, reservation.id, { state: 'failed', error: result.error, durationMs });
    return { status: 'error', error: result.error, retryable: result.retryable ?? false, toolCallId: reservation.id };
  }

  const validated = tool.output.safeParse(result.data);
  if (!validated.success) {
    // The write has committed, so the ledger row must say `succeeded` — marking
    // it failed would invite a retry that duplicates the row. The caller is
    // told honestly that the result could not be read.
    console.error(`[tool-exec] ${tool.name} returned an unexpected shape`, validated.error.issues);
    await finalizeCall(ledger, reservation.id, {
      state: 'succeeded',
      outputs: { result: result.data as Json, verified: null, detail: 'output failed schema validation' } as unknown as Json,
      error: `output schema mismatch: ${issueSummary(validated.error)}`,
      durationMs,
    });
    return {
      status: 'error',
      error: `${tool.name} made the change but returned something Bubaly could not read. Check it before trying again.`,
      retryable: false,
      toolCallId: reservation.id,
    };
  }
  const output = validated.data;

  // ── 6. Verify (§13) ──────────────────────────────────────────────────────
  let verified: boolean | undefined;
  let verificationDetail: string | null = null;
  if (tool.verify) {
    try {
      const check = await tool.verify(callScope, input, output);
      if (check.ok) {
        verified = check.data.verified;
        verificationDetail = check.data.detail;
      } else {
        verified = false;
        verificationDetail = check.error;
      }
    } catch (error) {
      console.error(`[tool-exec] ${tool.name} verification threw`, error);
      verified = false;
      verificationDetail = describeActionError(error, 'The change could not be confirmed.');
    }
    if (verified === false) console.error(`[tool-exec] ${tool.name} could not be verified: ${verificationDetail}`);
  }

  await finalizeCall(ledger, reservation.id, {
    state: 'succeeded',
    outputs: { result: output as Json, verified: verified ?? null, detail: verificationDetail } as unknown as Json,
    durationMs,
    resource: tool.resource?.(output) ?? null,
  });

  const summary = tool.summarize(input, output);

  // The domain services that already write a feed line say so on their
  // definition; everything else gets its line from here, so the family sees
  // every change Bubaly made in one place.
  if (tool.activityFrom !== 'service') {
    const activity = await recordActivity(callScope, {
      agent: tool.domain,
      action: trailActionFor(tool),
      title: summary,
      detail: verificationDetail,
      href: DOMAIN_HREF[tool.domain] ?? null,
    });
    if (!activity.ok) console.error(`[tool-exec] activity entry dropped for ${tool.name}`, activity.error);
  }

  return { status: 'ok', data: output, summary, toolCallId: reservation.id, ...(verified === undefined ? {} : { verified }) };
}

/** Run the tool's service, turning an unexpected throw into an honest failure. */
async function runService(scope: ServiceScope, tool: ToolDefinition, input: unknown) {
  try {
    return await tool.execute(scope, input);
  } catch (error) {
    console.error(`[tool-exec] ${tool.name} threw`, error);
    return {
      ok: false as const,
      error: describeActionError(error, `${tool.name} could not be completed.`),
      retryable: true,
    };
  }
}

/**
 * A call that already succeeded under this key. The stored outputs are
 * re-validated because the tool's schema may have changed since; when they no
 * longer fit, the family still gets the truth — it happened — without a made-up
 * summary.
 */
function replayDuplicate(tool: ToolDefinition, input: unknown, toolCallId: string, outputs: Json | null): ToolOutcome {
  const envelope = (outputs && typeof outputs === 'object' && !Array.isArray(outputs))
    ? (outputs as { result?: Json; verified?: Json })
    : null;
  const stored = envelope?.result ?? null;
  const validated = stored === null ? null : tool.output.safeParse(stored);

  if (validated?.success) {
    const verified = typeof envelope?.verified === 'boolean' ? envelope.verified : undefined;
    return {
      status: 'ok',
      data: validated.data,
      summary: tool.summarize(input, validated.data),
      toolCallId,
      ...(verified === undefined ? {} : { verified }),
    };
  }
  return {
    status: 'ok',
    data: stored,
    summary: 'Bubaly had already done this, so nothing was repeated.',
    toolCallId,
  };
}
