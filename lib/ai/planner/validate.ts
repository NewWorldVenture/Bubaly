// lib/ai/planner/validate.ts — what happens to a plan between the model and
// the database.
//
// The model's reply is structurally valid (lib/ai/structured.ts guarantees
// the schema) but not necessarily RUNNABLE or ALLOWED. This module makes it
// both, in one pass, without touching the database:
//
//   1. Shape — keys are unique, counts are bounded, descriptions are trimmed to
//      the lengths strict mode could not enforce.
//   2. Tools — an act/retrieve step must name a registry tool (`getTool`
//      resolves aliases and case) that is ALSO in the intent's catalogue
//      (`allowedTools`, the set the prompt offered: a real tool from another
//      intent's catalogue is dropped as `off_catalogue`, so the narrowing in
//      prompts.ts is a boundary, not advice); its `input` string must parse
//      to an object that satisfies that tool's zod input schema (after `conformNulls`, the
//      same bridge the executor applies). A step that fails either is DROPPED
//      — the executor would only refuse it later, and a plan the family
//      approves must be a plan that can actually run. A step whose type
//      disagrees with its tool (an `act` naming a read tool) is coerced.
//   3. Graph — dependencies on unknown keys are removed; dependents of a
//      dropped step are dropped too (their precondition is gone); a cycle
//      REJECTS the plan, because a cyclic plan has no runnable step and the
//      executor would report a completed run that did nothing.
//   4. Trust — a PURE dry run of the executor's gate per act step, over trust
//      inputs loaded once by the caller: `evaluateAction` then `riskToDecision`
//      exactly as `lib/ai/tools/execute.ts` applies them. `evaluateTrust` is
//      never called — it inserts a `trust_audit_logs` row per call, and a plan
//      is a proposal, not an action (tests/planner-validation.test.ts proves
//      no insert happens). `require_approval` marks the step; `deny` drops it.
//   5. Autonomy — the family's behaviour for the tool's domain (derived from
//      its `subject_kind='ai'` trust policies): `recommend` removes the step
//      from execution (the caller turns the plan into a recommendation),
//      `prepare` marks every act step approval-required.
//   6. Expansion — a step's `verify` slot becomes a `verify` step behind it;
//      a plan follow-up becomes a `followup` step (parks the run) behind every
//      leaf, followed by a `notify` to the managers with the follow-up's prompt.
//
// Pure apart from imports of other pure functions; `tests/planner-validation`
// drives it with the real registry and hand-built trust inputs.
import { conformNulls } from '@/lib/ai/schema-to-json';
import { findDependencyCycle, type StepState } from '@/lib/ai/runs/states';
import { parseNotifyInput } from '@/lib/ai/runs/executor';
import { parseVerificationSpec } from '@/lib/ai/runs/verify';
import { getTool } from '@/lib/ai/tools/registry';
import { bindingSources } from '@/lib/ai/runs/bindings';
import { behaviorForDomain, type AISettings } from '@/lib/ai/family-settings';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import type { AiStepType } from '@/lib/database.types';
import { zonedTimeMs } from '@/lib/services/scope';
import {
  evaluateAction, HIGH_STAKES_AI_DOMAINS, riskToDecision,
  type AutonomyBehavior, type Capability, type Decision, type Delegation, type Grant, type Policy, type TrustRole,
} from '@/lib/trust/engine';
import {
  MAX_DESCRIPTION_CHARS, MAX_FOLLOWUPS, MAX_OBJECTIVE_CHARS, MAX_REASONING_CHARS, MAX_STEPS,
  parseStepInput, toExecutorCondition, type Plan, type PlanRiskLevel, type PlanStep,
} from './schema';

export type PlanIssueCode =
  | 'duplicate_key' | 'too_many_steps' | 'missing_tool' | 'unknown_tool' | 'off_catalogue' | 'type_coerced' | 'invalid_input'
  | 'invalid_condition' | 'unknown_dependency' | 'dependency_dropped' | 'invalid_verify' | 'invalid_notify'
  | 'invalid_followup' | 'past_followup' | 'denied' | 'recommend_only' | 'cycle' | 'empty';

export type PlanIssue = { code: PlanIssueCode; step: string | null; message: string };

/** A step the executor can run, with the tool resolved and the decision made. */
export type ValidatedStep = {
  key: string;
  stepType: AiStepType;
  toolName: string | null;
  description: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  condition: Record<string, unknown> | null;
  approvalRequired: boolean;
  riskLevel: PlanRiskLevel;
  /** Why the step needs approval (or was allowed), for the run timeline and the approval card. */
  decisionReason: string | null;
  /** The family's autonomy behaviour that applied to this step, when one was recorded. */
  behavior: AutonomyBehavior | null;
  tool: ToolDefinition | null;
};

export type ValidationInputs = {
  /** Trust inputs loaded ONCE by the caller with `loadTrustInputs`. */
  policies: Policy[];
  grants: Grant[];
  delegations: Delegation[];
  emergencyDomains: string[];
  /** The requester's role as the executor will evaluate it (`system` → adult, see `trustRoleFor`). */
  role: TrustRole;
  /**
   * The family's own settings (0257). The planner used to read autonomy from
   * `subject_kind='ai'` trust policies alone — rows that Settings → Bubaly AI
   * has never written — so a family who set Meals to "Recommend only" got a
   * plan whose act steps were neither dropped nor marked approval-required.
   */
  settings?: AISettings | null;
  /** Planner confidence fed to policy conditions; the executor's default is 0.85. */
  confidence?: number;
  now: Date;
  tz: string;
  /**
   * Canonical names of the tools offered for this request (`catalogueNames`
   * over `toolsForIntent`). A step's name is resolved through `getTool` first,
   * so aliases and casing match; the resolved tool must be in this set.
   */
  allowedTools: ReadonlySet<string>;
};

/** The canonical names of a catalogue, for `ValidationInputs.allowedTools`. */
export function catalogueNames(tools: readonly Pick<ToolDefinition, 'name'>[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

export type ValidationResult =
  | {
    ok: true;
    objective: string;
    reasoningSummary: string;
    steps: ValidatedStep[];
    issues: PlanIssue[];
    riskLevel: PlanRiskLevel;
    requiresApproval: boolean;
    /** Act steps the household's `recommend` behaviour kept out of execution, for the recommendation body. */
    recommendOnly: ValidatedStep[];
    /** The dominant behaviour across the plan's act steps, or null when none is recorded. */
    behavior: AutonomyBehavior | null;
  }
  | { ok: false; code: 'cycle' | 'empty'; error: string; issues: PlanIssue[] };

const RISK_RANK: Record<PlanRiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(levels: PlanRiskLevel[]): PlanRiskLevel {
  return levels.reduce<PlanRiskLevel>((acc, level) => (RISK_RANK[level] > RISK_RANK[acc] ? level : acc), 'low');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function issueSummary(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.length ? issue.path.join('.') : 'input'}: ${issue.message}`).join('; ');
}

// ── Autonomy ────────────────────────────────────────────────────────────────

const AI_CAPABILITIES: ReadonlySet<string> = new Set(['automate', 'all']);

function effectToBehavior(effect: Policy['effect']): AutonomyBehavior {
  if (effect === 'deny') return 'recommend';
  if (effect === 'require_approval') return 'prepare';
  return 'execute';
}

/**
 * The household's autonomy behaviour for a domain, read from the same
 * `subject_kind='ai'` trust policies `evaluateAction` will match — today only
 * the concierge dial writes one (the scheduling row). The settings page writes
 * `family_ai_settings` instead, which is why `behaviorFor` reads both and takes
 * the stricter. A domain with no row and no `all` row returns null: "no
 * preference recorded", which the engine treats as "gate by risk and role",
 * not as permission.
 */
export function autonomyBehaviorFor(policies: Policy[], domain: string): AutonomyBehavior | null {
  const matching = policies
    .filter((p) => p.enabled && p.subjectKind === 'ai' && AI_CAPABILITIES.has(p.capability) && (p.domain === domain || p.domain === 'all'))
    .sort((a, b) => (b.priority - a.priority) || (a.domain === domain ? -1 : b.domain === domain ? 1 : 0));
  const best = matching[0];
  return best ? effectToBehavior(best.effect) : null;
}

/**
 * The household's autonomy behaviour for a domain, from BOTH places a family
 * can express it: the settings page (0257 `family_ai_settings`) and a trust
 * policy. The stricter of the two wins, because both are the family's word and
 * the cautious reading is the one they can undo.
 *
 * `execute` from the settings row is the default — "no restriction" — so it is
 * folded back to null, preserving the "no preference recorded" answer the
 * planner and the engine both rely on.
 */
export function behaviorFor(inputs: ValidationInputs, domain: string): AutonomyBehavior | null {
  const fromPolicy = autonomyBehaviorFor(inputs.policies, domain);
  const raw = inputs.settings ? behaviorForDomain(inputs.settings, domain) : null;
  return dominantBehavior([fromPolicy, raw === 'execute' ? null : raw]);
}

/** The behaviour that describes the plan as a whole: the most restrictive one any act step carries. */
export function dominantBehavior(behaviors: (AutonomyBehavior | null)[]): AutonomyBehavior | null {
  const rank: Record<AutonomyBehavior, number> = { execute: 0, prepare: 1, recommend: 2 };
  let best: AutonomyBehavior | null = null;
  for (const behavior of behaviors) {
    if (behavior && (best === null || rank[behavior] > rank[best])) best = behavior;
  }
  return best;
}

// ── The pure trust dry run ──────────────────────────────────────────────────

export type DryRunDecision = Decision & { capability: Capability; skipped: boolean };

/**
 * Exactly what `lib/ai/tools/execute.ts gate()` would decide for this tool
 * call, without its side effects (no approval row, no audit row). The two must
 * agree, or the approval flags a family reviews at plan time would not match
 * what the executor does at run time — so the actor, capability, confidence
 * and tags below are copied from the executor verbatim.
 */
export function dryRunGate(tool: ToolDefinition, input: unknown, inputs: ValidationInputs, behavior: AutonomyBehavior | null): DryRunDecision {
  const readSkipsGate = tool.readOnly && !HIGH_STAKES_AI_DOMAINS.includes(tool.domain);
  if (readSkipsGate) {
    return { effect: 'allow', reason: 'A read that needs no permission.', basis: 'role_default', capability: tool.capability, skipped: true };
  }
  const actor = { kind: 'ai_agent' as const, id: 'bubaly', role: inputs.role };
  const capability: Capability = tool.readOnly ? tool.capability : 'automate';
  const confidence = inputs.confidence ?? 0.85;
  const amountCents = readAmountCents(input);

  let decision = evaluateAction({
    actor,
    domain: tool.domain,
    capability,
    context: {
      confidence,
      tags: [`op:${tool.capability}`, `risk:${tool.risk}`, `domain:${tool.domain}`],
      now: inputs.now.getTime(),
      ...(amountCents !== null ? { amountCents } : {}),
    },
    policies: inputs.policies,
    grants: inputs.grants,
    delegations: inputs.delegations,
    emergencyDomains: inputs.emergencyDomains,
  });

  // Same rule as the executor's gate (lib/ai/tools/execute.ts): the tier speaks
  // where the answer came from the generic role matrix, and also over a
  // blanket `domain=all/capability=all` allow, which is not a decision about
  // this action. Over a blanket it may only tighten.
  const fromGenericRule = decision.basis === 'role_default' || decision.basis === 'fallback';
  const blanketAllow = decision.basis === 'policy' && decision.effect === 'allow' && decision.policyScope === 'broad';
  if (fromGenericRule || blanketAllow) {
    const risked = riskToDecision({
      risk: tool.risk,
      actor,
      domain: tool.domain,
      capability,
      explicitAllow: false,
      ...(behavior ? { behavior } : {}),
    });
    if (risked && (fromGenericRule || risked.effect !== 'allow')) decision = risked;
  }
  return { ...decision, capability, skipped: false };
}

/** A money amount in the arguments, for `maxAmountCents` policy conditions; null when the tool carries none. */
function readAmountCents(input: unknown): number | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['amount_cents', 'amountCents']) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Math.round(record[key] as number);
  }
  for (const key of ['amount', 'budget', 'target_amount', 'cost']) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Math.round((record[key] as number) * 100);
  }
  return null;
}

// ── Follow-ups ──────────────────────────────────────────────────────────────

const RELATIVE_RE = /^\s*(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\s*$/i;

/**
 * When a follow-up fires, as an ISO instant. Accepts an absolute instant (with
 * a zone), a family-local naive time (`2026-09-10T09:00:00`, resolved in the
 * family's zone), or a delay (`2d`, `12h`, `45m`). Null when unparseable.
 */
export function resolveFollowupAt(after: string, now: Date, tz: string): string | null {
  const text = after.trim();
  const relative = RELATIVE_RE.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith('m') ? n * 60_000 : unit.startsWith('h') ? n * 3_600_000 : unit.startsWith('d') ? n * 86_400_000 : n * 7 * 86_400_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const naive = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::\d{2})?)?$/.exec(text);
  if (naive) {
    const ms = zonedTimeMs(naive[1], naive[2] ? Number(naive[2]) : 9, naive[3] ? Number(naive[3]) : 0, tz);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const absolute = Date.parse(text);
  return Number.isFinite(absolute) ? new Date(absolute).toISOString() : null;
}

// ── The pipeline ────────────────────────────────────────────────────────────

type Draft = ValidatedStep & { verifySpec: unknown | null };

function stepRisk(step: Pick<ValidatedStep, 'stepType' | 'tool'>): PlanRiskLevel {
  if (step.stepType === 'act' && step.tool) return step.tool.risk;
  return 'low';
}

/**
 * Validate one model reply. Never throws; a plan the executor cannot run comes
 * back as `ok:false` with the issues phrased for the repair round, and a plan
 * with some bad steps comes back `ok:true` with those steps dropped and the
 * reasons listed.
 */
export function validatePlan(plan: Plan, inputs: ValidationInputs): ValidationResult {
  const issues: PlanIssue[] = [];
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  const dropped = new Set<string>();
  const recommendOnly: ValidatedStep[] = [];
  const behaviors: (AutonomyBehavior | null)[] = [];

  const rawSteps = plan.steps.slice(0, MAX_STEPS);
  if (plan.steps.length > MAX_STEPS) {
    issues.push({ code: 'too_many_steps', step: null, message: `The plan had ${plan.steps.length} steps; only the first ${MAX_STEPS} were kept.` });
  }

  // Pass 1: shape, tools, inputs, decisions — per step, independent of the graph.
  for (const raw of rawSteps) {
    const key = raw.key.trim();
    if (!key || seen.has(key)) {
      issues.push({ code: 'duplicate_key', step: key || null, message: key ? `Step key "${key}" is used twice; the second was dropped.` : 'A step had no key and was dropped.' });
      continue;
    }
    seen.add(key);

    const draft = buildDraft(raw, key, inputs, issues);
    if (!draft) {
      dropped.add(key);
      continue;
    }
    if (draft.stepType === 'act' && draft.tool) {
      behaviors.push(draft.behavior);
      if (draft.behavior === 'recommend') {
        recommendOnly.push(draft);
        dropped.add(key);
        issues.push({ code: 'recommend_only', step: key, message: `"${draft.description}" was kept as a recommendation: this household has asked Bubaly not to make ${draft.tool.domain.replace(/_/g, ' ')} changes on its own.` });
        continue;
      }
    }
    drafts.push(draft);
  }

  // A step's input may name an earlier step's result (`$fromStep`). The executor
  // resolves those against the DEPENDENCY results it has in hand, so a binding
  // to a step this one does not depend on is unresolvable by construction — it
  // would fail at execution, after the plan looked fine. Caught here, before
  // the graph pass, so the cascade below drops whatever depended on it too.
  for (let i = drafts.length - 1; i >= 0; i -= 1) {
    const draft = drafts[i];
    const missing = bindingSources(draft.input).filter((key) => !draft.dependsOn.includes(key));
    if (!missing.length) continue;
    drafts.splice(i, 1);
    dropped.add(draft.key);
    issues.push({
      code: 'invalid_input',
      step: draft.key,
      message: `"${draft.key}" uses the result of ${missing.map((k) => `"${k}"`).join(', ')} without depending on it. List it in depends_on, or stop referring to it.`,
    });
  }

  // Pass 2: the graph. Unknown dependencies are removed; dependents of dropped
  // steps are dropped transitively (their precondition no longer exists).
  const keys = new Set(drafts.map((d) => d.key));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = drafts.length - 1; i >= 0; i -= 1) {
      const draft = drafts[i];
      const dependsOnDropped = draft.dependsOn.find((dep) => dropped.has(dep));
      if (dependsOnDropped) {
        drafts.splice(i, 1);
        keys.delete(draft.key);
        dropped.add(draft.key);
        issues.push({ code: 'dependency_dropped', step: draft.key, message: `"${draft.description}" was dropped because it depends on "${dependsOnDropped}", which could not be planned.` });
        changed = true;
        continue;
      }
      const unknown = draft.dependsOn.filter((dep) => !keys.has(dep));
      if (unknown.length) {
        draft.dependsOn = draft.dependsOn.filter((dep) => keys.has(dep));
        issues.push({ code: 'unknown_dependency', step: draft.key, message: `Step "${draft.key}" depended on ${unknown.map((k) => `"${k}"`).join(', ')}, which do not exist; those dependencies were removed.` });
      }
    }
  }

  const cycle = findDependencyCycle(drafts.map((d) => ({ id: d.key, status: 'queued' as StepState, dependency_ids: d.dependsOn })));
  if (cycle) {
    const message = `Steps depend on each other in a loop: ${cycle.join(' → ')}. Break the loop so every step has a step it can start from.`;
    issues.push({ code: 'cycle', step: cycle[0] ?? null, message });
    return { ok: false, code: 'cycle', error: message, issues };
  }

  // Pass 3: expansion — verify slots, then follow-ups behind every leaf.
  const expanded: ValidatedStep[] = [];
  for (const draft of drafts) {
    const { verifySpec, ...step } = draft;
    expanded.push(step);
    if (verifySpec) {
      expanded.push({
        key: `${draft.key}__verify`,
        stepType: 'verify',
        toolName: null,
        description: `Check that "${draft.description}" really happened`,
        input: verifySpec as Record<string, unknown>,
        dependsOn: [draft.key],
        condition: null,
        approvalRequired: false,
        riskLevel: 'low',
        decisionReason: null,
        behavior: null,
        tool: null,
      });
    }
  }
  appendFollowups(expanded, plan.followups.slice(0, MAX_FOLLOWUPS), inputs, issues);

  if (!expanded.length) {
    const error = recommendOnly.length
      ? 'Every action in this plan is one the household has asked Bubaly to recommend rather than perform.'
      : 'The plan has no step Bubaly can run.';
    issues.push({ code: 'empty', step: null, message: error });
    return { ok: false, code: 'empty', error, issues };
  }

  return {
    ok: true,
    objective: clip(plan.objective, MAX_OBJECTIVE_CHARS),
    reasoningSummary: clip(plan.reasoning_summary, MAX_REASONING_CHARS),
    steps: expanded,
    issues,
    riskLevel: maxRisk(expanded.map((s) => s.riskLevel)),
    requiresApproval: expanded.some((s) => s.approvalRequired),
    recommendOnly,
    behavior: dominantBehavior(behaviors),
  };
}

/** One step through shape → tool → input → condition → decision. Null when it must be dropped. */
function buildDraft(raw: PlanStep, key: string, inputs: ValidationInputs, issues: PlanIssue[]): Draft | null {
  const description = clip(raw.description || key, MAX_DESCRIPTION_CHARS);
  const parsedInput = parseStepInput(raw.input);
  if (!parsedInput.ok) {
    issues.push({ code: 'invalid_input', step: key, message: `Step "${key}": ${parsedInput.error}.` });
    return null;
  }
  let condition: Record<string, unknown> | null = null;
  if (raw.condition) {
    condition = toExecutorCondition(raw.condition);
    if (!condition) issues.push({ code: 'invalid_condition', step: key, message: `Step "${key}" had a condition with no comparison; it will always run.` });
  }

  const base: Omit<Draft, 'stepType' | 'toolName' | 'input' | 'approvalRequired' | 'riskLevel' | 'decisionReason' | 'behavior' | 'tool' | 'verifySpec'> = {
    key, description, dependsOn: [...new Set(raw.depends_on.map((d) => d.trim()).filter(Boolean))], condition,
  };
  const verifySpec = parseVerifySlot(raw, key, issues);

  switch (raw.step_type) {
    case 'act':
    case 'retrieve': {
      const name = raw.tool_name?.trim() ?? '';
      if (!name) {
        issues.push({ code: 'missing_tool', step: key, message: `Step "${key}" is a ${raw.step_type} step with no tool name; name a tool from the catalogue.` });
        return null;
      }
      const tool = getTool(name);
      if (!tool) {
        issues.push({ code: 'unknown_tool', step: key, message: `Step "${key}" names a tool that does not exist ("${name}"); use only tools from the catalogue.` });
        return null;
      }
      if (!inputs.allowedTools.has(tool.name)) {
        // The tool is real, but not one this request was offered: the
        // catalogue is the boundary of what a meal plan may touch, and a
        // model that reaches past it must not get the executor's authority.
        issues.push({ code: 'off_catalogue', step: key, message: `Step "${key}" names ${tool.name}, which is not in the catalogue for this request; use only the tools listed in the catalogue.` });
        return null;
      }
      const conformed = conformNulls(tool.input, parsedInput.value);
      // A value the plan cannot know yet — the id of a row a later step will
      // create — is written as a binding (`$fromStep`), which is an object
      // where the tool wants a string. So a step carrying one cannot be checked
      // against the tool's schema here, and is not: `executeTool` validates the
      // RESOLVED input against that same schema before it does anything, which
      // is the only moment the real value exists. What IS checked here is that
      // every binding names a step this one depends on (below).
      const hasBindings = bindingSources(conformed).length > 0;
      const checked = hasBindings ? { success: true as const, data: conformed } : tool.input.safeParse(conformed);
      if (!checked.success) {
        issues.push({ code: 'invalid_input', step: key, message: `Step "${key}" (${tool.name}) has arguments the tool cannot use — ${issueSummary(checked.error)}.` });
        return null;
      }
      const stepType: AiStepType = tool.readOnly ? 'retrieve' : 'act';
      if (stepType !== raw.step_type) {
        issues.push({ code: 'type_coerced', step: key, message: `Step "${key}" was marked ${raw.step_type} but ${tool.name} is a ${tool.readOnly ? 'read' : 'write'}; it was corrected.` });
      }
      const behavior = tool.readOnly ? null : behaviorFor(inputs, tool.domain);
      if (stepType === 'act' && behavior === 'recommend') {
        // The household's own policy would deny this at the gate; it is not a
        // refusal to report but the §11 level-1 contract — the step becomes
        // part of the recommendation instead of the run (validatePlan sorts it).
        return {
          ...base, stepType, toolName: tool.name, input: checked.data as Record<string, unknown>, approvalRequired: false,
          riskLevel: stepRisk({ stepType, tool }), decisionReason: 'This household has asked Bubaly to recommend rather than act here.',
          behavior, tool, verifySpec,
        };
      }
      const decision = dryRunGate(tool, checked.data, inputs, behavior);
      if (decision.effect === 'deny') {
        issues.push({ code: 'denied', step: key, message: `"${description}" was left out: ${decision.reason}` });
        return null;
      }
      // `prepare` holds every write for a person, regardless of what the risk
      // tier would have allowed; the model's own flag is honoured too.
      const approvalRequired = stepType === 'act' && (decision.effect === 'require_approval' || behavior === 'prepare' || raw.approval_required === true);
      return {
        ...base,
        stepType,
        toolName: tool.name,
        input: checked.data as Record<string, unknown>,
        approvalRequired,
        riskLevel: stepRisk({ stepType, tool }),
        decisionReason: approvalRequired
          ? (decision.effect === 'require_approval' ? decision.reason : behavior === 'prepare' ? 'This household has asked Bubaly to prepare changes and wait for a yes.' : 'Bubaly chose to ask first.')
          : null,
        behavior,
        tool,
        verifySpec,
      };
    }
    case 'notify': {
      const parsed = parseNotifyInput(parsedInput.value);
      if (!parsed.ok) {
        issues.push({ code: 'invalid_notify', step: key, message: `Step "${key}": ${parsed.error} Give it {recipients, type, title, body}.` });
        return null;
      }
      return { ...base, stepType: 'notify', toolName: null, input: parsedInput.value, approvalRequired: raw.approval_required === true, riskLevel: 'low', decisionReason: null, behavior: null, tool: null, verifySpec: null };
    }
    case 'verify': {
      const parsed = parseVerificationSpec(parsedInput.value);
      if (!parsed.ok) {
        issues.push({ code: 'invalid_verify', step: key, message: `Step "${key}": ${parsed.error}` });
        return null;
      }
      return { ...base, stepType: 'verify', toolName: null, input: parsedInput.value, approvalRequired: false, riskLevel: 'low', decisionReason: null, behavior: null, tool: null, verifySpec: null };
    }
    case 'followup': {
      const raw2 = parsedInput.value;
      const at = typeof raw2.runAfter === 'string' ? resolveFollowupAt(raw2.runAfter, inputs.now, inputs.tz) : null;
      const minutes = typeof raw2.delayMinutes === 'number' && Number.isFinite(raw2.delayMinutes) ? Math.max(1, Math.round(raw2.delayMinutes)) : null;
      if (!at && minutes === null) {
        issues.push({ code: 'invalid_followup', step: key, message: `Step "${key}" is a followup with no time; give it {runAfter: ISO} or {delayMinutes: n}.` });
        return null;
      }
      if (at && Date.parse(at) <= inputs.now.getTime()) {
        issues.push({ code: 'past_followup', step: key, message: `Step "${key}" follows up at a time that has already passed.` });
        return null;
      }
      return { ...base, stepType: 'followup', toolName: null, input: at ? { runAfter: at } : { delayMinutes: minutes }, approvalRequired: false, riskLevel: 'low', decisionReason: null, behavior: null, tool: null, verifySpec: null };
    }
    case 'approval':
      return {
        ...base, stepType: 'approval', toolName: null,
        input: { summary: typeof parsedInput.value.summary === 'string' ? parsedInput.value.summary : description, consequences: Array.isArray(parsedInput.value.consequences) ? parsedInput.value.consequences : [] },
        approvalRequired: true, riskLevel: 'low', decisionReason: 'The plan asks a person before continuing.', behavior: null, tool: null, verifySpec: null,
      };
    default:
      return null;
  }
}

function parseVerifySlot(raw: PlanStep, key: string, issues: PlanIssue[]): unknown | null {
  if (!raw.verify || !raw.verify.trim()) return null;
  const parsed = parseStepInput(raw.verify);
  if (!parsed.ok) {
    issues.push({ code: 'invalid_verify', step: key, message: `Step "${key}" has a verify spec that is not a JSON object; it was ignored.` });
    return null;
  }
  const spec = parseVerificationSpec(parsed.value);
  if (!spec.ok) {
    issues.push({ code: 'invalid_verify', step: key, message: `Step "${key}" has a verify spec Bubaly cannot check (${spec.error}); it was ignored.` });
    return null;
  }
  return parsed.value;
}

/**
 * Follow-ups run LAST: a `followup` step parks the run until its time, so it
 * must depend on every leaf, or the executor would park the run before the
 * work. Each follow-up's prompt reaches the managers as a notification when
 * the run resumes — the honest implementation while the executor has no
 * re-planning port (see `replanRun` in ./index.ts for the day it does).
 */
function appendFollowups(steps: ValidatedStep[], followups: Plan['followups'], inputs: ValidationInputs, issues: PlanIssue[]): void {
  const resolved = followups
    .map((f, index) => ({ index, at: resolveFollowupAt(f.after, inputs.now, inputs.tz), prompt: clip(f.prompt, MAX_DESCRIPTION_CHARS) }))
    .filter((f) => {
      if (!f.at) {
        issues.push({ code: 'invalid_followup', step: null, message: `Follow-up ${f.index + 1} has a time Bubaly cannot read ("${followups[f.index].after}"); it was dropped.` });
        return false;
      }
      if (Date.parse(f.at) <= inputs.now.getTime()) {
        issues.push({ code: 'past_followup', step: null, message: `Follow-up ${f.index + 1} is set for a time that has already passed; it was dropped.` });
        return false;
      }
      return Boolean(f.prompt);
    })
    .sort((a, b) => Date.parse(a.at as string) - Date.parse(b.at as string));
  if (!resolved.length || !steps.length) return;

  const dependedOn = new Set(steps.flatMap((s) => s.dependsOn));
  let previous = steps.filter((s) => !dependedOn.has(s.key)).map((s) => s.key);
  resolved.forEach((f, n) => {
    const key = `followup_${n + 1}`;
    steps.push({
      key, stepType: 'followup', toolName: null, description: `Check back later: ${f.prompt}`,
      input: { runAfter: f.at }, dependsOn: previous, condition: null, approvalRequired: false, riskLevel: 'low', decisionReason: null, behavior: null, tool: null,
    });
    const notifyKey = `${key}__notify`;
    steps.push({
      key: notifyKey, stepType: 'notify', toolName: null, description: `Remind the parents: ${f.prompt}`,
      input: { recipients: 'managers', type: 'system', title: 'Bubaly follow-up', body: f.prompt },
      dependsOn: [key], condition: null, approvalRequired: false, riskLevel: 'low', decisionReason: null, behavior: null, tool: null,
    });
    previous = [notifyKey];
  });
}
