// lib/ai/planner/templates/index.ts — deterministic workflow skeletons.
//
// WHY templates at all: a model asked to plan "our week" from a blank page
// invents steps — tools that do not exist, a grocery list before the meals, a
// notification to nobody. A template is the shape of the workflow the spec
// already wrote out (§18 A–G, §8): the reads that run in parallel, the writes
// that depend on them, the verification, the notification, the follow-ups.
// The model's job shrinks to filling inputs and dropping what does not apply,
// which is a job it does well. Two more things fall out of it:
//
//   - a template that needs no model-authored input (`deterministic: true`)
//     can be instantiated and run by a routine with no LLM call at all;
//   - every template names the roster agent (lib/agents/roster.ts) that owns
//     the workflow, so the chief-of-staff synthesis and the run timeline show
//     one engine rather than a second taxonomy.
//
// Templates are pure: a `TemplateContext` (dates already resolved in the
// family's zone) in, a `Plan`-shaped object out. No I/O, no `server-only`, so
// tests/planner-templates.test.ts can check every skeleton's tool names and
// inputs against the registry without a database.
import type { AgentId } from '@/lib/agents/roster';
import type { IntentKey } from '@/lib/ai/context/intents';
import { encodeStepInput, type Plan, type PlanStep, type PlanStepType } from '../schema';
import { chiefOfStaffTemplate } from './chief-of-staff';
import { backToSchoolTemplate } from './back-to-school';
import { emergencyPrepTemplate } from './emergency-prep';
import { findVendorTemplate } from './find-vendor';
import { holidayTemplate } from './holiday';
import { lifeEventTemplate } from './life-event';
import { organizeWeekendTemplate } from './organize-weekend';
import { schoolMorningTemplate } from './school-morning';
import { tournamentDayTemplate } from './tournament-day';
import { dailyBriefTemplate } from './daily-brief';
import { planMealsTemplate } from './plan-meals';
import { planMoveTemplate } from './plan-move';
import { planWeekTemplate } from './plan-week';
import { prepareVacationTemplate } from './prepare-vacation';
import { remindEveryoneTemplate } from './remind-everyone';
import { spendingReviewTemplate } from './spending-review';
import { whatAmIForgettingTemplate } from './what-am-i-forgetting';

/**
 * Everything a template needs to write concrete inputs. Every day key is
 * family-local (`YYYY-MM-DD`) and every instant is a naive local ISO time the
 * tools already accept ("ISO 8601 in the family timezone").
 */
export type TemplateContext = {
  tz: string;
  nowIso: string;
  todayKey: string;
  tomorrowKey: string;
  dayAfterTomorrowKey: string;
  /** Monday of the week being planned: next Monday when today is Friday or later, this Monday otherwise. */
  weekStartKey: string;
  /** The Sunday that closes `weekStartKey`'s week. */
  weekEndKey: string;
  /** The coming Saturday and Sunday. */
  weekendStartKey: string;
  weekendEndKey: string;
  /** `YYYY-MM` of the month under review and the one before it. */
  monthKey: string;
  previousMonthKey: string;
  /** First and last day of the month under review. */
  monthStartKey: string;
  monthEndKey: string;
  /** First and last day of the previous month. */
  previousMonthStartKey: string;
  previousMonthEndKey: string;
  requestText: string;
  /** Entities the classifier read from the request (day, person, topic, trade…). */
  entities: Record<string, string>;
  viewerName: string | null;
  viewerMemberId: string | null;
  /** `family_members.id`s of the managers, for person-specific notifications. */
  managerIds: string[];
  /** Upcoming trips on file, so a vacation plan can name a real `vacation_id`. */
  trips: { id: string; title: string; startDate: string | null; daysUntil: number | null }[];
  /** The move on file and the live rows a move plan personalises from; null when the request is not about a move or nothing is on file. */
  move: MoveContext | null;
};

/**
 * What `plan-move.ts` writes its steps from: the move (so every step names a
 * real `move_id`) and the rows that turn a generic checklist into this
 * family's — one address change per subscription and bill, one records
 * request per child's school, one vet visit per pet.
 */
export type MoveContext = {
  /** The move on file, or null when the family has none yet — the steps then address "the current move" and the skeleton's first step puts one on file. */
  move: {
    id: string;
    title: string;
    moveDate: string;
    hasKids: boolean;
    hasPets: boolean;
    /** Template keys already generated on the move, so a re-plan adds nothing twice. */
    templateKeys: string[];
  } | null;
  subscriptions: { id: string; name: string }[];
  bills: { id: string; name: string; category: string | null }[];
  schoolClasses: { memberId: string; memberName: string | null; schoolName: string | null }[];
  pets: { id: string; name: string; vetName: string | null }[];
};

export type TemplateStep = {
  key: string;
  stepType: PlanStepType;
  toolName?: string;
  description: string;
  dependsOn?: string[];
  /** Concrete arguments from the context. Return `{}` for a tool that needs none. */
  input: (ctx: TemplateContext) => Record<string, unknown>;
  /**
   * What the model must add before this step is runnable (dish names, the
   * event to move, who to tell). Rendered as a hint next to the skeleton; a
   * template with any of these is not `deterministic`.
   */
  modelFills?: string;
  /** A verification spec to run after the step (JSON object), when one applies. */
  verify?: (ctx: TemplateContext) => Record<string, unknown> | null;
  /** True for steps the model should drop when the context shows they do not apply. */
  optional?: boolean;
};

export type WorkflowTemplate = {
  intent: IntentKey;
  /** The roster specialist that owns this workflow. */
  agent: AgentId;
  title: string;
  objective: (ctx: TemplateContext) => string;
  steps: TemplateStep[];
  /**
   * Steps that only exist once the context says how many there are — one
   * address change per tracked subscription, one records request per school.
   * Appended after `steps` when the template is instantiated; they may depend
   * on static steps and static steps never depend on them.
   */
  dynamicSteps?: (ctx: TemplateContext) => TemplateStep[];
  followups?: (ctx: TemplateContext) => { after: string; prompt: string }[];
  /** True when every input is fully determined by the context — a routine can run it without a model. */
  deterministic: boolean;
  /** Intent-specific planning rules, appended to the planner prompt. */
  guidance: string[];
};

const TEMPLATES: Partial<Record<IntentKey, WorkflowTemplate>> = {
  daily_brief: dailyBriefTemplate,
  plan_meals: planMealsTemplate,
  plan_week: planWeekTemplate,
  organize_weekend: organizeWeekendTemplate,
  remind_everyone: remindEveryoneTemplate,
  prepare_vacation: prepareVacationTemplate,
  spending_review: spendingReviewTemplate,
  find_vendor: findVendorTemplate,
  what_am_i_forgetting: whatAmIForgettingTemplate,
  // The generic skeleton for a request that reaches across the household:
  // reads first, acts by area, then the asker is told. `other` stays
  // template-less on purpose — it is for text nothing recognised, and a
  // skeleton that assumed a sweep would be the wrong shape for most of it.
  chief_of_staff: chiefOfStaffTemplate,
  plan_move: planMoveTemplate,
  // M25 — the outcome cards launch these.
  tournament_day: tournamentDayTemplate,
  school_morning: schoolMorningTemplate,
  back_to_school: backToSchoolTemplate,
  holiday: holidayTemplate,
  emergency_prep: emergencyPrepTemplate,
  // M34 — a transition the household is heading into.
  life_event: lifeEventTemplate,
};

/** The template for an intent, or null for intents that plan from scratch (answer_question, capture, other…). */
export function templateFor(intent: IntentKey): WorkflowTemplate | null {
  return TEMPLATES[intent] ?? null;
}

/** Every template, in a stable order, for tests and the admin surface. */
export function allTemplates(): WorkflowTemplate[] {
  return Object.values(TEMPLATES).filter((t): t is WorkflowTemplate => Boolean(t));
}

/** Every step the template produces for this context: the fixed skeleton plus whatever the context multiplies out. */
export function templateSteps(template: WorkflowTemplate, ctx: TemplateContext): TemplateStep[] {
  return [...template.steps, ...(template.dynamicSteps?.(ctx) ?? [])];
}

/**
 * Turn a template into the exact `Plan` shape the model would return, with
 * every input already encoded. This is both the skeleton the prompt shows the
 * model and the plan a deterministic routine saves directly.
 */
export function instantiateTemplate(template: WorkflowTemplate, ctx: TemplateContext): Plan {
  const steps: PlanStep[] = templateSteps(template, ctx).map((step) => ({
    key: step.key,
    step_type: step.stepType,
    tool_name: step.toolName ?? null,
    description: step.description,
    input: encodeStepInput(step.input(ctx)),
    depends_on: [...(step.dependsOn ?? [])],
    condition: null,
    approval_required: null,
    verify: step.verify ? (() => { const spec = step.verify(ctx); return spec ? JSON.stringify(spec) : null; })() : null,
  }));
  return {
    objective: template.objective(ctx),
    reasoning_summary: '',
    risk_level: 'low',
    steps,
    followups: template.followups?.(ctx) ?? [],
    clarification: null,
    answer: null,
  };
}

// ── Date arithmetic on day keys ─────────────────────────────────────────────
// Day keys are already family-local, so shifting them is calendar arithmetic
// with no zone involved: noon UTC of the key, plus whole days, back to a key.

/** `days` after `dayKey` (negative for before). */
export function shiftDay(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (!Number.isFinite(ms)) return dayKey;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a day key. */
export function weekdayOf(dayKey: string): number {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : 0;
}

/** The Monday on or before `dayKey`. */
export function mondayOf(dayKey: string): string {
  const weekday = weekdayOf(dayKey);
  return shiftDay(dayKey, weekday === 0 ? -6 : 1 - weekday);
}

/** Local-naive ISO instant for a day key at `hh:mm` — the form the tools accept as "ISO 8601 in the family timezone". */
export function localTime(dayKey: string, hour: number, minute = 0): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dayKey}T${pad(hour)}:${pad(minute)}:00`;
}

/** `YYYY-MM` of a day key. */
export function monthOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** First and last day keys of a `YYYY-MM` month. */
export function monthBounds(monthKey: string): { start: string; end: string } {
  const [y, m] = monthKey.split('-').map(Number);
  const start = `${monthKey}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${monthKey}-${String(lastDay).padStart(2, '0')}` };
}

export type TemplateContextInput = {
  tz: string;
  nowIso: string;
  todayKey: string;
  requestText: string;
  entities?: Record<string, string> | null;
  viewerName?: string | null;
  viewerMemberId?: string | null;
  managerIds?: string[];
  trips?: TemplateContext['trips'];
  move?: MoveContext | null;
};

/**
 * Resolve every date a template refers to from "today" in the family's zone.
 *
 * "The week" is the coming one once the weekend is near: asked on a Friday,
 * Saturday or Sunday, "plan our week" means next Monday onward; asked on a
 * Tuesday it means the rest of this week. "The weekend" is always the next
 * Saturday–Sunday, including today when today is Saturday.
 */
export function templateContextFrom(input: TemplateContextInput): TemplateContext {
  const today = input.todayKey;
  const weekday = weekdayOf(today);
  const thisMonday = mondayOf(today);
  const weekStartKey = weekday === 0 || weekday >= 5 ? shiftDay(thisMonday, 7) : thisMonday;
  const weekEndKey = shiftDay(weekStartKey, 6);
  const daysToSaturday = weekday === 6 ? 0 : (6 - weekday) % 7;
  const weekendStartKey = weekday === 0 ? shiftDay(today, 6) : shiftDay(today, daysToSaturday);
  const weekendEndKey = shiftDay(weekendStartKey, 1);
  const monthKey = monthOf(today);
  const previousMonthKey = monthOf(shiftDay(monthBounds(monthKey).start, -1));
  const month = monthBounds(monthKey);
  const previous = monthBounds(previousMonthKey);
  return {
    tz: input.tz,
    nowIso: input.nowIso,
    todayKey: today,
    tomorrowKey: shiftDay(today, 1),
    dayAfterTomorrowKey: shiftDay(today, 2),
    weekStartKey,
    weekEndKey,
    weekendStartKey,
    weekendEndKey,
    monthKey,
    previousMonthKey,
    monthStartKey: month.start,
    monthEndKey: month.end,
    previousMonthStartKey: previous.start,
    previousMonthEndKey: previous.end,
    requestText: input.requestText,
    entities: input.entities ?? {},
    viewerName: input.viewerName ?? null,
    viewerMemberId: input.viewerMemberId ?? null,
    managerIds: input.managerIds ?? [],
    trips: input.trips ?? [],
    move: input.move ?? null,
  };
}
