// lib/ai/planner/prompts.ts — the planner's system prompt, versioned.
//
// The prompt is assembled from four parts, in this order, because the model
// weighs early text most: the §66 identity it shares with the chat assistant
// (lib/ai/prompts/assistant.ts), the planning rules (graph shape, what each
// step type means, when to ask, what the reasoning summary may say), the
// workflow template's own guidance, and finally the tool catalogue — the ONLY
// tool names the model may use. The catalogue is narrowed per intent (§27:
// a meal plan does not need to know about passports), which also keeps the
// prompt short enough that the household context fits beside it.
//
// `PLANNER_PROMPT_VERSION` is stamped on `ai_plans.planner_prompt_version` so
// an eval regression can be traced to the prompt change that caused it. Bump
// it when a rule changes meaning.
//
// Pure: no I/O, no `server-only`. The tool catalogue is rendered from
// definitions the caller passes in, so tests can render it for any subset.
import type { IntentKey } from '@/lib/ai/context/intents';
import { BUBALY_CHIEF_OF_STAFF_PRINCIPLE, CHIEF_OF_STAFF_QUESTIONS, VOICE_RULES } from '@/lib/ai/prompts/assistant';
import { UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import { UnsupportedSchemaError, zodToStrictJsonSchema, type JsonSchema } from '@/lib/ai/schema-to-json';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import type { AutonomyBehavior, TrustDomain } from '@/lib/trust/engine';
import { PLAN_STEP_TYPES, type Plan } from './schema';
import type { WorkflowTemplate } from './templates/index';

export const PLANNER_PROMPT_VERSION = 'planner-2026-09-05.1';

/**
 * Which trust domains' tools each intent is offered. `family`, `memory` and
 * `notifications` (messaging) ride along everywhere because every plan may
 * need to name a person, recall a fact or tell someone. `other` gets the
 * broad set: it is the intent for requests nothing recognised.
 */
export const INTENT_TOOL_DOMAINS: Record<IntentKey, TrustDomain[]> = {
  plan_meals: ['meal_planning', 'shopping', 'calendar', 'tasks', 'scheduling', 'finances', 'messaging'],
  plan_week: ['calendar', 'education', 'tasks', 'chores', 'meal_planning', 'shopping', 'scheduling', 'home_maintenance', 'travel', 'messaging'],
  organize_weekend: ['calendar', 'education', 'tasks', 'chores', 'scheduling', 'messaging'],
  remind_everyone: ['calendar', 'education', 'tasks', 'chores', 'scheduling', 'messaging'],
  prepare_vacation: ['travel', 'documents', 'calendar', 'tasks', 'scheduling', 'home_maintenance', 'shopping', 'messaging'],
  spending_review: ['finances', 'meal_planning', 'tasks', 'messaging'],
  find_vendor: ['home_maintenance', 'tasks', 'scheduling', 'calendar', 'messaging'],
  what_am_i_forgetting: ['calendar', 'education', 'tasks', 'chores', 'scheduling', 'documents', 'home_maintenance', 'finances', 'travel', 'messaging'],
  daily_brief: ['calendar', 'education', 'tasks', 'chores', 'scheduling', 'meal_planning', 'messaging'],
  answer_question: ['calendar', 'education', 'tasks', 'chores', 'scheduling', 'meal_planning', 'shopping', 'travel', 'home_maintenance', 'documents', 'finances', 'messaging'],
  capture: ['calendar', 'tasks', 'chores', 'scheduling', 'shopping', 'messaging'],
  navigate: [],
  other: ['calendar', 'education', 'tasks', 'chores', 'scheduling', 'meal_planning', 'shopping', 'travel', 'home_maintenance', 'documents', 'finances', 'messaging'],
};

/** Domains offered to every intent regardless of the table above. */
const ALWAYS_DOMAINS: TrustDomain[] = ['messaging'];

/** The registry tools the planner may offer for an intent. Order is the registry's (reads before writes per domain). */
export function toolsForIntent(intent: IntentKey, all: ToolDefinition[]): ToolDefinition[] {
  const wanted = new Set<string>([...(INTENT_TOOL_DOMAINS[intent] ?? INTENT_TOOL_DOMAINS.other), ...ALWAYS_DOMAINS]);
  return all.filter((tool) => wanted.has(tool.domain) || tool.name.startsWith('family.') || tool.name.startsWith('memory.'));
}

/** `title: string, starts_at: string, ends_at?: string, category?: general|school|…` from a tool's strict JSON schema. */
function fieldSummary(schema: JsonSchema): string {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const parts: string[] = [];
  for (const [name, node] of Object.entries(properties)) {
    const types = Array.isArray(node.type) ? (node.type as string[]) : node.type ? [String(node.type)] : [];
    const nullable = types.includes('null');
    const base = types.filter((t) => t !== 'null');
    let rendered: string;
    if (Array.isArray(node.enum)) {
      rendered = (node.enum as unknown[]).filter((v) => v !== null).map(String).join('|');
    } else if (base[0] === 'array') {
      const items = (node.items ?? {}) as JsonSchema;
      rendered = items.type === 'object' ? `[{${fieldSummary(items)}}]` : `${String(items.type ?? 'any')}[]`;
    } else if (base[0] === 'object') {
      rendered = `{${fieldSummary(node)}}`;
    } else {
      rendered = base[0] ?? 'any';
    }
    parts.push(`${name}${nullable ? '?' : ''}: ${rendered}`);
  }
  return parts.join(', ');
}

/** One line per tool: name, read/write, risk, description, and its input fields. */
export function renderToolCatalogue(tools: ToolDefinition[]): string {
  return tools.map((tool) => {
    let fields: string;
    try {
      fields = fieldSummary(zodToStrictJsonSchema(tool.input));
    } catch (error) {
      // A tool whose input cannot be expressed in strict JSON Schema is still
      // callable; the model gets its description and must infer the shape.
      if (!(error instanceof UnsupportedSchemaError)) console.error(`[planner] could not render the input schema for ${tool.name}`, error);
      fields = 'see description';
    }
    const kind = tool.readOnly ? 'read' : `write, ${tool.risk} risk`;
    return `- ${tool.name} [${kind}]: ${tool.description} Input: {${fields || ''}}`;
  }).join('\n');
}

const STEP_TYPE_RULES = [
  `Step types: ${PLAN_STEP_TYPES.join(', ')}.`,
  'retrieve = a read-only tool. act = a tool that changes something. verify = re-check what an act step wrote (input is a verification spec). notify = tell people (input: {recipients:"family"|"managers"|[member ids], type, title, body}). approval = wait for a person before the steps after it. followup = pause the whole run until a later time (input: {runAfter: ISO} or {delayMinutes: n}).',
  'Retrieve steps that do not need each other must have an empty depends_on so they run in parallel. Act steps depend on the reads they need. Verify and notify steps depend on the acts they confirm or announce.',
  'Every act and retrieve step names a tool from the catalogue exactly; a step that names anything else is discarded. Write each step\'s input as a JSON object string whose fields match that tool\'s Input.',
  'Times are ISO 8601 in the family\'s time zone, e.g. 2026-09-12T09:00:00. Day keys are YYYY-MM-DD. Resolve "tomorrow", "next Friday", "this weekend" against the date in the context.',
  'Write inputs in full from the household context: the dishes, the titles, the people, the dates. A step cannot read another step\'s output at run time.',
  'Prefer one step per created thing (one task per person, one event per activity) so each can be approved, retried and reported on its own.',
  'Keep plans under thirty steps. Drop skeleton steps that the context shows do not apply; never add a step whose only purpose is narration.',
];

const DECISION_RULES = [
  'Set approval_required to true for anything that spends money, sends a message outside the family, deletes or moves something people are counting on, or that a parent would clearly want to be asked about. Leave it null otherwise — household policy decides.',
  'Set clarification ONLY when a missing fact would materially change the outcome and neither the request nor the context answers it (for example, which trip when several are on file, or whether a repair is an emergency). One short question, then empty steps. Otherwise make the sensible choice and say what you chose in the reasoning summary.',
  'When the request is a question with nothing to change, set answer to the answer in plain words and leave steps empty.',
  'reasoning_summary is read by the family: what you chose and why, in two or three sentences of plain language. Outcomes, not deliberation. Never mention tools, modules, agents, steps, schemas or policies.',
  'Descriptions are one plain sentence each, the way a person would describe the action: "Plan seven dinners around soccer nights", "Remind Maya to pack her cleats".',
];

const AUTONOMY_LINES: Record<AutonomyBehavior, string> = {
  recommend: 'This household has asked Bubaly to recommend only. Plan the analysis and the notification; every change you would make will be presented as a recommendation for a person to accept, so describe it clearly.',
  prepare: 'This household has asked Bubaly to prepare work and wait: every act step will be held for approval before it runs. Plan it in full anyway so a parent can approve the whole thing in one go.',
  execute: 'This household has authorized Bubaly to execute routine work on its own. Prefer doing over asking; approval is only needed where household policy or risk demands it.',
};

export type PlannerPromptInput = {
  intent: IntentKey;
  template: WorkflowTemplate | null;
  tools: ToolDefinition[];
  /** The family's dominant autonomy behaviour, or null when none is recorded. */
  behavior: AutonomyBehavior | null;
  viewerRole: string;
};

/** The system prompt for one planning call. */
export function buildPlannerSystemPrompt(input: PlannerPromptInput): string {
  const sections: string[] = [
    BUBALY_CHIEF_OF_STAFF_PRINCIPLE,
    'You are planning, not chatting: reply with one JSON plan that matches the schema. The plan is a graph of steps a separate executor runs, verifies and reports on, so the family sees your plan as a timeline of actions.',
    '',
    `Intent: ${input.intent}`,
    `Requester role: ${input.viewerRole}. A child or teen may only be planned work their role allows; the executor enforces this, so do not plan finance or document changes for them.`,
    ...(input.behavior ? [AUTONOMY_LINES[input.behavior]] : []),
    '',
    'Keep answering, in order: ' + CHIEF_OF_STAFF_QUESTIONS.join(' '),
    '',
    'How to plan:',
    ...STEP_TYPE_RULES.map((rule) => `- ${rule}`),
    '',
    'What to decide:',
    ...DECISION_RULES.map((rule) => `- ${rule}`),
    ...VOICE_RULES.map((rule) => `- ${rule}`),
    `- ${UNTRUSTED_CONTENT_RULE}`,
  ];

  if (input.template) {
    sections.push('', `Workflow: ${input.template.title} (${input.template.agent.replace(/_/g, ' ')}).`, 'Rules for this workflow:');
    sections.push(...input.template.guidance.map((rule) => `- ${rule}`));
  }

  sections.push('', 'Tool catalogue — the only tools you may name:', renderToolCatalogue(input.tools));
  return sections.join('\n');
}

export type PlannerUserMessageInput = {
  requestText: string;
  /** The context bundle's prompt-ready text (already fenced and budgeted). */
  contextText: string;
  /** The instantiated template, when one exists. */
  skeleton: Plan | null;
  /** Hints the template attaches to steps the model must fill. */
  skeletonHints: { key: string; hint: string }[];
  answers?: Record<string, string> | null;
  pageContext?: { module?: string; entityIds?: string[] } | null;
};

/** The user turn: the household context, the request, prior answers, and the skeleton to fill. */
export function buildPlannerUserMessage(input: PlannerUserMessageInput): string {
  const parts: string[] = [input.contextText, ''];
  if (input.pageContext?.module) {
    parts.push(`The person is on the "${input.pageContext.module}" page${input.pageContext.entityIds?.length ? ` looking at ${input.pageContext.entityIds.join(', ')}` : ''}.`, '');
  }
  const answers = Object.entries(input.answers ?? {}).filter(([, value]) => typeof value === 'string' && value.trim());
  if (answers.length) {
    parts.push('Answers the person already gave — do not ask these again:');
    parts.push(...answers.map(([question, answer]) => `- ${question}: ${answer.trim()}`), '');
  }
  parts.push(`Request: ${input.requestText.trim()}`);
  if (input.skeleton) {
    parts.push('', 'Recommended skeleton for this workflow. Keep the keys, fill or replace the inputs from the context, drop steps that do not apply, add steps the request needs:');
    parts.push(JSON.stringify(input.skeleton.steps, null, 0));
    if (input.skeletonHints.length) {
      parts.push('Steps you must fill before they can run:');
      parts.push(...input.skeletonHints.map((h) => `- ${h.key}: ${h.hint}`));
    }
    if (input.skeleton.followups.length) {
      parts.push(`Suggested follow-ups: ${JSON.stringify(input.skeleton.followups)}`);
    }
  }
  return parts.join('\n');
}

/**
 * The single repair turn (§5: at most one). The issues are the validator's,
 * phrased for the model; the plan it returns replaces the first one entirely.
 */
export function buildRepairMessage(issues: string[]): string {
  return [
    'Your plan had problems the executor cannot run. Fix every one and reply with the complete corrected plan:',
    ...issues.slice(0, 12).map((issue) => `- ${issue}`),
  ].join('\n');
}
