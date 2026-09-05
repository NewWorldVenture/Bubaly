// lib/ai/result-cards.ts — the structured outcomes Bubaly shows instead of chat
// bubbles (§53), and the wire contract that carries them.
//
// WHY A SEPARATE, DEPENDENCY-FREE MODULE: the same card travels three ways —
// as an SSE `card` event to the web client, as `cards[]` in the JSON reply the
// phone reads, and as `ai_messages.structured_content` so a conversation
// re-opens with its outcomes intact. Server, browser and tests all import this
// file, so it must never pull `server-only` code or a provider.
//
// WHAT A CARD NEVER CONTAINS: a tool name, an argument blob, or reasoning. A
// card is what a family member sees ("5 dinners planned", "soccer and the
// dentist overlap Saturday"), not how the assistant got there (§35, §37).
// `cardFromToolResult` is the one place the translation from tool output to
// card happens, so every surface renders the same outcome for the same result.
import { z } from 'zod';

// ─── Card kinds ─────────────────────────────────────────────────────────────

export const RESULT_CARD_KINDS = [
  'meal_plan', 'calendar_conflict', 'budget_analysis', 'vacation_prep', 'task_group',
  'grocery_list', 'readiness', 'summary', 'approval', 'run_status',
] as const;
export type ResultCardKind = (typeof RESULT_CARD_KINDS)[number];

const text = z.string();
const optionalText = z.string().nullable().optional();
/** A short "label: value" line — the atom every compact layout is built from. */
const fact = z.object({ label: text, value: text });

export const MealPlanCardSchema = z.object({
  kind: z.literal('meal_plan'),
  title: text,
  subtitle: optionalText,
  week_start: optionalText,
  days: z.array(z.object({
    date: text,
    label: text,
    meals: z.array(z.object({ meal_type: text, name: z.string().nullable() })),
  })),
  replaced: z.number().int().nonnegative().nullable().optional(),
  created_meals: z.number().int().nonnegative().nullable().optional(),
  href: optionalText,
});

export const CalendarConflictCardSchema = z.object({
  kind: z.literal('calendar_conflict'),
  title: text,
  subtitle: optionalText,
  conflicts: z.array(z.object({
    when: text,
    titles: z.array(text),
    member: z.string().nullable(),
    event_ids: z.array(text),
  })),
  href: optionalText,
});

export const BudgetAnalysisCardSchema = z.object({
  kind: z.literal('budget_analysis'),
  title: text,
  subtitle: optionalText,
  period: optionalText,
  currency: z.string().default('USD'),
  /** Dollars, as the finance tools report them. */
  total_spent: z.number(),
  total_limit: z.number().nullable(),
  /** Previous-period total when the card is a comparison. */
  previous_total: z.number().nullable().optional(),
  rows: z.array(z.object({
    label: text,
    spent: z.number(),
    limit: z.number().nullable(),
    share: z.number().nullable(),
    delta: z.number().nullable(),
    over: z.boolean(),
  })),
  insight: optionalText,
  href: optionalText,
});

export const VacationPrepCardSchema = z.object({
  kind: z.literal('vacation_prep'),
  title: text,
  subtitle: optionalText,
  trip_id: optionalText,
  destination: optionalText,
  dates: optionalText,
  items: z.array(z.object({ label: text, detail: z.string().nullable(), done: z.boolean() })),
  next_steps: z.array(text),
  href: optionalText,
});

export const TaskGroupCardSchema = z.object({
  kind: z.literal('task_group'),
  title: text,
  subtitle: optionalText,
  tasks: z.array(z.object({
    id: z.string().nullable(),
    title: text,
    assignee: z.string().nullable(),
    due: z.string().nullable(),
    done: z.boolean(),
  })),
  href: optionalText,
});

export const GroceryListCardSchema = z.object({
  kind: z.literal('grocery_list'),
  title: text,
  subtitle: optionalText,
  list_id: optionalText,
  items: z.array(z.object({
    name: text,
    quantity: z.string().nullable(),
    category: z.string().nullable(),
    checked: z.boolean(),
  })),
  skipped: z.array(text),
  in_pantry: z.array(text),
  href: optionalText,
});

export const ReadinessCardSchema = z.object({
  kind: z.literal('readiness'),
  title: text,
  subtitle: optionalText,
  score: z.number().min(0).max(100),
  level: text,
  days_until: z.number().int().nullable(),
  factors: z.array(z.object({ label: text, score: z.number() })),
  recommendations: z.array(text),
  risks: z.array(z.object({ title: text, detail: z.string().nullable(), severity: z.number() })),
  href: optionalText,
});

export const SummaryCardSchema = z.object({
  kind: z.literal('summary'),
  title: text,
  subtitle: optionalText,
  facts: z.array(fact),
  items: z.array(text),
  note: optionalText,
  href: optionalText,
});

/**
 * The approval card carries exactly what `components/approvals/approval-card`
 * renders — `ApprovalCardData` from `lib/approvals/card-data`, spelled out here
 * so a stored card is validated like every other kind.
 */
export const ApprovalCardDataSchema = z.object({
  id: text,
  title: text,
  summary: z.string().nullable(),
  consequences: z.array(text),
  domain: text,
  requestedBy: z.string().nullable(),
  requestedAt: text,
  expiresAt: z.string().nullable(),
  runId: z.string().nullable(),
  amountCents: z.number().nullable(),
  canEdit: z.boolean(),
  editableFields: z.array(z.object({
    key: text,
    label: text,
    value: z.union([z.string(), z.number(), z.boolean()]),
    type: z.enum(['text', 'number', 'boolean']),
  })).optional(),
  agent: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
});

export const ApprovalCardSchema = z.object({
  kind: z.literal('approval'),
  title: text,
  subtitle: optionalText,
  approval: ApprovalCardDataSchema,
});

export const RunStatusCardSchema = z.object({
  kind: z.literal('run_status'),
  title: text,
  subtitle: optionalText,
  run_id: text,
  /** A `RunState` when known; free text is tolerated so an older row still renders. */
  status: text,
  summary: z.string().nullable(),
  steps_done: z.number().int().nullable(),
  steps_total: z.number().int().nullable(),
  href: text,
});

export const ResultCardSchema = z.discriminatedUnion('kind', [
  MealPlanCardSchema, CalendarConflictCardSchema, BudgetAnalysisCardSchema, VacationPrepCardSchema,
  TaskGroupCardSchema, GroceryListCardSchema, ReadinessCardSchema, SummaryCardSchema,
  ApprovalCardSchema, RunStatusCardSchema,
]);

export type MealPlanCard = z.infer<typeof MealPlanCardSchema>;
export type CalendarConflictCard = z.infer<typeof CalendarConflictCardSchema>;
export type BudgetAnalysisCard = z.infer<typeof BudgetAnalysisCardSchema>;
export type VacationPrepCard = z.infer<typeof VacationPrepCardSchema>;
export type TaskGroupCard = z.infer<typeof TaskGroupCardSchema>;
export type GroceryListCard = z.infer<typeof GroceryListCardSchema>;
export type ReadinessCard = z.infer<typeof ReadinessCardSchema>;
export type SummaryCard = z.infer<typeof SummaryCardSchema>;
export type ApprovalResultCard = z.infer<typeof ApprovalCardSchema>;
export type RunStatusCard = z.infer<typeof RunStatusCardSchema>;
export type ResultCard = z.infer<typeof ResultCardSchema>;

/** A card if the value is one, else null — never throws, never partially trusts. */
export function parseResultCard(value: unknown): ResultCard | null {
  const parsed = ResultCardSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ─── Stream + persistence contracts ─────────────────────────────────────────

/** The run detail page — spelled once so every card links to the same place. */
export function runHref(runId: string): string {
  return `/dashboard/concierge/runs/${encodeURIComponent(runId)}`;
}

/**
 * The SSE events `POST /api/ai` streams, in the order they can arrive:
 *   `action`  — a tool finished; `summary` is the family-readable line (clients
 *               render the summary only, never `name`, which is kept for evals)
 *   `card`    — the tool's outcome as a card; follows the `action` it belongs to
 *   `run`     — the tool started or attached a run; clients render a run card
 *   `delta`   — assistant text
 *   `error`   — the stream or persistence broke; text so far is still valid
 *   `done`    — the final text and whether the turn was saved
 */
export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'action'; name: string; ok: boolean; summary: string }
  | { type: 'card'; card: ResultCard }
  | { type: 'run'; runId: string; href: string; status: string; summary: string | null }
  | { type: 'error'; error: string }
  | { type: 'done'; content: string; persisted: boolean };

/** Parse one decoded SSE payload. Unknown or malformed events are dropped, not thrown. */
export function parseAssistantStreamEvent(raw: unknown): AssistantStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;
  switch (ev.type) {
    case 'delta':
      return typeof ev.text === 'string' ? { type: 'delta', text: ev.text } : null;
    case 'action':
      return { type: 'action', name: typeof ev.name === 'string' ? ev.name : '', ok: ev.ok !== false, summary: typeof ev.summary === 'string' && ev.summary ? ev.summary : 'Done' };
    case 'card': {
      const card = parseResultCard(ev.card);
      return card ? { type: 'card', card } : null;
    }
    case 'run':
      if (typeof ev.runId !== 'string' || !ev.runId) return null;
      return {
        type: 'run',
        runId: ev.runId,
        href: typeof ev.href === 'string' && ev.href ? ev.href : runHref(ev.runId),
        status: typeof ev.status === 'string' && ev.status ? ev.status : 'queued',
        summary: typeof ev.summary === 'string' ? ev.summary : null,
      };
    case 'error':
      return { type: 'error', error: typeof ev.error === 'string' && ev.error ? ev.error : 'Something went wrong.' };
    case 'done':
      return { type: 'done', content: typeof ev.content === 'string' ? ev.content : '', persisted: ev.persisted !== false };
    default:
      return null;
  }
}

/** The run card the client shows for a `run` event, and for a persisted run id on reload. */
export function runStatusCard(input: { runId: string; status?: string | null; summary?: string | null; stepsDone?: number | null; stepsTotal?: number | null }): RunStatusCard {
  const status = input.status ?? 'queued';
  return {
    kind: 'run_status',
    title: RUN_TITLES[status] ?? 'Bubaly is on it',
    run_id: input.runId,
    status,
    summary: input.summary ?? null,
    steps_done: input.stepsDone ?? null,
    steps_total: input.stepsTotal ?? null,
    href: runHref(input.runId),
  };
}

const RUN_TITLES: Record<string, string> = {
  queued: 'Bubaly is getting started',
  planning: 'Bubaly is planning',
  awaiting_context: 'Bubaly has a question',
  awaiting_approval: 'Waiting for your approval',
  ready: 'Bubaly is about to start',
  executing: 'Bubaly is working on it',
  verifying: 'Bubaly is double-checking',
  scheduled_followup: 'Bubaly will follow up',
  paused: 'Paused',
  completed: 'Done',
  partially_completed: 'Mostly done',
  blocked: 'Needs you',
  failed: 'That didn’t work',
  cancelled: 'Cancelled',
};

export const STRUCTURED_CONTENT_VERSION = 1;

/** What `ai_messages.structured_content` holds: the cards of the turn plus the runs it touched. */
export type StructuredContent = { version: number; cards: ResultCard[]; runIds: string[] };

/** Null when the turn produced nothing structured, so the column stays null instead of `{cards:[]}`. */
export function toStructuredContent(cards: ResultCard[], runIds: string[]): StructuredContent | null {
  if (cards.length === 0 && runIds.length === 0) return null;
  return { version: STRUCTURED_CONTENT_VERSION, cards, runIds: [...new Set(runIds)] };
}

/** Read a stored column back; every card is re-validated because the schema may have moved on. */
export function structuredContentFrom(value: unknown): { cards: ResultCard[]; runIds: string[] } {
  if (!value || typeof value !== 'object') return { cards: [], runIds: [] };
  const record = value as Record<string, unknown>;
  const cards = Array.isArray(record.cards) ? record.cards.map(parseResultCard).filter((c): c is ResultCard => c !== null) : [];
  const runIds = Array.isArray(record.runIds) ? record.runIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  return { cards, runIds };
}

// ─── Tool result → card ─────────────────────────────────────────────────────

/**
 * The card-bearing tools by canonical name. Legacy flat names and the
 * underscored on-the-wire spelling are both resolved here so a transcript
 * from any era derives the same card; the engine additionally resolves
 * through the registry, this map is what keeps the function pure.
 */
const TOOL_ALIASES: Record<string, string> = {
  plan_week_meals: 'meals.planWeek', create_meal_plan: 'meals.planWeek',
  get_meal_plan: 'meals.getMealPlan', list_meal_plan: 'meals.getMealPlan',
  find_calendar_conflicts: 'calendar.findConflicts', check_conflicts: 'calendar.findConflicts',
  budget_vs_actual: 'finances.budgetVsActual', check_budgets: 'finances.budgetVsActual',
  spending_by_category: 'finances.spendingByCategory', get_spending_summary: 'finances.spendingByCategory',
  compare_spending_periods: 'finances.comparePeriods',
  build_trip_plan: 'trips.buildPlan', plan_vacation: 'trips.buildPlan',
  create_packing_list: 'trips.createPackingList', generate_packing_list: 'trips.createPackingList',
  trip_readiness: 'trips.computeReadiness', vacation_readiness: 'trips.computeReadiness',
  trip_conflicts: 'trips.commitmentConflicts', what_clashes_with_trip: 'trips.commitmentConflicts',
  add_groceries_from_meal_plan: 'groceries.addFromMealPlan', grocery_list_from_meal_plan: 'groceries.addFromMealPlan',
  add_grocery_item: 'groceries.addItems', add_grocery_items: 'groceries.addItems', add_to_shopping_list: 'groceries.addItems',
  get_grocery_list: 'groceries.listOpen', list_grocery_items: 'groceries.listOpen',
  list_todos: 'tasks.searchTodos', search_todos: 'tasks.searchTodos',
  list_open_chores: 'tasks.listOpenChores',
};

const TOOL_DOMAINS = new Set(['calendar', 'meals', 'groceries', 'tasks', 'finances', 'trips', 'reminders', 'home', 'notifications', 'family', 'documents', 'memory', 'messages', 'school', 'sports']);

/** `calendar_findConflicts` / `find_calendar_conflicts` / `calendar.findConflicts` → `calendar.findConflicts`. */
export function canonicalToolName(name: string): string {
  if (name.includes('.')) return name;
  const alias = TOOL_ALIASES[name];
  if (alias) return alias;
  const idx = name.indexOf('_');
  if (idx > 0 && TOOL_DOMAINS.has(name.slice(0, idx))) return `${name.slice(0, idx)}.${name.slice(idx + 1)}`;
  return name;
}

export type CardContext = {
  /** `family_members.id` → display name, so cards say "Dan", never an id. */
  members?: Record<string, string>;
  currency?: string;
};

type Rec = Record<string, unknown>;
const asRecord = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(asRecord).filter((x): x is Rec => x !== null) : []);

/** The structured payload of a tool result, whichever adapter produced it. */
export function toolResultData(result: unknown): Rec | null {
  const r = asRecord(result);
  if (!r || r.ok === false) return null;
  return asRecord(r.data);
}

/** The run a tool result points at, if any — a tool that started or resumed a run says so here. */
export function runIdFromToolResult(result: unknown): string | null {
  const r = asRecord(result);
  if (!r || r.ok === false) return null;
  const data = asRecord(r.data);
  return str(r.run_id) ?? str(r.runId) ?? (data ? str(data.run_id) ?? str(data.runId) : null);
}

/** The approval a gated tool result is waiting on. */
export function approvalIdFromToolResult(result: unknown): string | null {
  const r = asRecord(result);
  if (!r || r.pending_approval !== true) return null;
  return str(r.approval_id) ?? str(r.approvalId);
}

function memberName(ctx: CardContext, id: unknown): string | null {
  return typeof id === 'string' ? ctx.members?.[id] ?? null : null;
}

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];

function dayLabel(dateKey: string): string {
  const ms = Date.parse(`${dateKey}T12:00:00Z`);
  if (!Number.isFinite(ms)) return dateKey;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
}

function mealPlanCard(title: string, slots: Rec[], extra: { week_start?: string | null; replaced?: number | null; created_meals?: number | null }): MealPlanCard | null {
  const byDate = new Map<string, { meal_type: string; name: string | null }[]>();
  for (const s of slots) {
    const date = str(s.date);
    if (!date) continue;
    const list = byDate.get(date) ?? [];
    list.push({ meal_type: str(s.meal_type) ?? 'dinner', name: str(s.name) });
    byDate.set(date, list);
  }
  if (byDate.size === 0) return null;
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, meals]) => ({
    date,
    label: dayLabel(date),
    meals: meals.sort((a, b) => MEAL_ORDER.indexOf(a.meal_type) - MEAL_ORDER.indexOf(b.meal_type)),
  }));
  return {
    kind: 'meal_plan',
    title,
    week_start: extra.week_start ?? days[0].date,
    days,
    replaced: extra.replaced ?? null,
    created_meals: extra.created_meals ?? null,
    href: '/dashboard/meals',
  };
}

function groceryCard(title: string, data: Rec): GroceryListCard | null {
  const raw = records(data.added).length ? records(data.added) : records(data.items);
  const items = raw.flatMap((i) => {
    const name = str(i.name);
    return name ? [{ name, quantity: str(i.quantity), category: str(i.category), checked: i.is_checked === true }] : [];
  });
  const skipped = strings(data.skipped);
  const in_pantry = strings(data.in_pantry);
  if (items.length === 0 && skipped.length === 0 && in_pantry.length === 0) return null;
  return { kind: 'grocery_list', title, list_id: str(data.list_id), items, skipped, in_pantry, href: '/dashboard/grocery' };
}

function budgetCard(title: string, name: string, data: Rec, ctx: CardContext): BudgetAnalysisCard | null {
  const currency = ctx.currency ?? 'USD';
  const range = asRecord(data.range);
  const period = range ? `${str(range.from) ?? ''} – ${str(range.to) ?? ''}`.trim() : str(data.month);
  if (name === 'finances.budgetVsActual') {
    const rows = records(data.budgets).flatMap((b) => {
      const label = str(b.category);
      const spent = num(b.spent);
      return label && spent !== null ? [{ label, spent, limit: num(b.limit), share: num(b.pct), delta: null, over: b.over === true }] : [];
    });
    const over = num(data.over_count) ?? rows.filter((r) => r.over).length;
    return {
      kind: 'budget_analysis', title, period, currency,
      total_spent: num(data.total_spent) ?? rows.reduce((s, r) => s + r.spent, 0),
      total_limit: num(data.total_limit),
      rows,
      insight: rows.length === 0 ? 'No budgets are set up yet.' : over === 0 ? 'Every budget is on track.' : `${over} ${over === 1 ? 'budget is' : 'budgets are'} over.`,
      href: '/dashboard/budgets',
    };
  }
  if (name === 'finances.comparePeriods') {
    const rows = records(data.categories).flatMap((c) => {
      const label = str(c.category);
      const spent = num(c.current);
      return label && spent !== null ? [{ label, spent, limit: null, share: null, delta: num(c.delta), over: (num(c.delta) ?? 0) > 0 }] : [];
    });
    const current = num(data.current) ?? 0;
    const previous = num(data.previous) ?? 0;
    const delta = num(data.delta) ?? current - previous;
    return {
      kind: 'budget_analysis', title, period, currency,
      total_spent: current, total_limit: null, previous_total: previous, rows,
      insight: delta === 0 ? 'Spending is unchanged from the previous period.' : `Spending is ${delta > 0 ? 'up' : 'down'} ${formatMoney(Math.abs(delta), currency)} versus the previous period.`,
      href: '/dashboard/budgets',
    };
  }
  // finances.spendingByCategory
  const rows = records(data.categories).flatMap((c) => {
    const label = str(c.category);
    const spent = num(c.spent);
    return label && spent !== null ? [{ label, spent, limit: null, share: num(c.share), delta: null, over: false }] : [];
  });
  if (rows.length === 0 && num(data.total) === null) return null;
  return {
    kind: 'budget_analysis', title, period, currency,
    total_spent: num(data.total) ?? rows.reduce((s, r) => s + r.spent, 0), total_limit: null, rows,
    insight: rows[0] ? `${rows[0].label} was the biggest category.` : 'No spending in this window.',
    href: '/dashboard/budgets',
  };
}

/** "$1,234" / "$12.50" — dollars in, the family's currency out; falls back rather than throwing on a bad code. */
export function formatMoney(dollars: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2 }).format(dollars);
  } catch {
    return `$${dollars.toFixed(2)}`;
  }
}

function readinessCard(title: string, data: Rec): ReadinessCard | null {
  const score = num(data.score);
  if (score === null) return null;
  return {
    kind: 'readiness',
    title,
    subtitle: str(data.title),
    score: Math.max(0, Math.min(100, score)),
    level: (str(data.level) ?? 'unknown').replace(/_/g, ' '),
    days_until: num(data.days_until),
    factors: records(data.factors).flatMap((f) => (str(f.label) && num(f.score) !== null ? [{ label: str(f.label) as string, score: num(f.score) as number }] : [])),
    recommendations: strings(data.recommendations),
    risks: records(data.document_risks).flatMap((r) => (str(r.title) ? [{ title: str(r.title) as string, detail: str(r.detail), severity: num(r.severity) ?? 1 }] : [])),
    href: str(data.trip_id) ? `/dashboard/vacations/${encodeURIComponent(str(data.trip_id) as string)}` : '/dashboard/vacations',
  };
}

function vacationCard(title: string, name: string, data: Rec, args: Rec, ctx: CardContext): VacationPrepCard | null {
  const tripId = str(args.vacation_id) ?? str(data.trip_id) ?? str(data.id);
  const href = tripId ? `/dashboard/vacations/${encodeURIComponent(tripId)}` : '/dashboard/vacations';
  if (name === 'trips.buildPlan') {
    const added = asRecord(data.added);
    if (data.built !== true || !added) return null;
    const line = (label: string, count: number | null) => (count && count > 0 ? [{ label: `${count} ${label}${count === 1 ? '' : 's'}`, detail: null, done: true }] : []);
    const items = [
      ...line('activity', num(added.activities)).map((i) => ({ ...i, label: i.label.replace('activitys', 'activities') })),
      ...line('itinerary entry', num(added.items)).map((i) => ({ ...i, label: i.label.replace('entrys', 'entries') })),
      ...line('budget line', num(added.budget)),
      ...line('packing item', num(added.packing)),
    ];
    return { kind: 'vacation_prep', title, trip_id: tripId, destination: null, dates: null, items, next_steps: ['Review the itinerary and adjust anything that doesn’t fit.'], href };
  }
  if (name === 'trips.createPackingList') {
    const lists = records(data.lists);
    if (lists.length === 0) return null;
    const items = lists.map((l) => ({
      label: str(l.name) ?? memberName(ctx, l.member_id) ?? 'Packing list',
      detail: `${num(l.added) ?? 0} added${num(l.skipped) ? `, ${num(l.skipped)} already there` : ''}`,
      done: true,
    }));
    return { kind: 'vacation_prep', title, trip_id: tripId, destination: null, dates: null, items, next_steps: [], href };
  }
  if (name === 'trips.commitmentConflicts') {
    const window = asRecord(data.window);
    const items = records(data.items).flatMap((i) => (str(i.title) ? [{ label: str(i.title) as string, detail: [str(i.when), memberName(ctx, i.member_id)].filter(Boolean).join(' · ') || null, done: false }] : []));
    return {
      kind: 'vacation_prep', title, trip_id: tripId, destination: null,
      dates: window ? `${str(window.from) ?? ''} – ${str(window.to) ?? ''}` : null,
      items,
      next_steps: items.length ? ['Move, skip or pay early each of these before you leave.'] : [],
      href,
    };
  }
  // trips.getTrip / findOrCreateVacation — a trip summary.
  const counts = asRecord(data.counts);
  const items = counts
    ? (['lodging', 'flights', 'transport', 'activities', 'reservations', 'documents'] as const).flatMap((k) => {
      const n = num(counts[k]);
      return n === null ? [] : [{ label: k.charAt(0).toUpperCase() + k.slice(1), detail: n === 0 ? 'nothing yet' : String(n), done: n > 0 }];
    })
    : [];
  if (!str(data.title)) return null;
  const start = str(data.start_date);
  const end = str(data.end_date);
  return {
    kind: 'vacation_prep', title, subtitle: str(data.title), trip_id: tripId, destination: str(data.destination),
    dates: start && end ? `${start} – ${end}` : start,
    items, next_steps: [], href,
  };
}

function taskGroupCard(title: string, data: Rec, ctx: CardContext): TaskGroupCard | null {
  const rows = records(data.todos).length ? records(data.todos) : records(data.assignments);
  const tasks = rows.flatMap((t) => {
    const label = str(t.title);
    if (!label) return [];
    return [{ id: str(t.id), title: label, assignee: memberName(ctx, t.assigned_to_id ?? t.member_id), due: str(t.due) ?? str(t.due_date) ?? str(t.due_at), done: t.is_done === true || str(t.status) === 'done' }];
  });
  if (tasks.length === 0) return null;
  return { kind: 'task_group', title, tasks, href: data.assignments ? '/dashboard/chores' : '/dashboard/todos' };
}

const HIDDEN_FACT_KEYS = new Set(['id', 'ok', 'summary', 'card', 'verified', 'tool_call_id', 'pending_approval', 'approval_id', 'run_id', 'runId']);

function humanKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function factValue(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 && value.length <= 120 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

/**
 * The default card for structured output no specific card claims: the scalar
 * facts a person can read (never ids) and the first list of named things.
 * Returns null when the data holds nothing readable — a bare `{id}` result is
 * better shown as its one-line summary than as an empty card.
 */
export function summaryCardFromData(title: string, data: Rec, opts: { maxFacts?: number; maxItems?: number } = {}): SummaryCard | null {
  const maxFacts = opts.maxFacts ?? 6;
  const maxItems = opts.maxItems ?? 8;
  const facts: { label: string; value: string }[] = [];
  let items: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (HIDDEN_FACT_KEYS.has(key) || /(^|_)id$/i.test(key)) continue;
    const scalar = factValue(value);
    if (scalar !== null) {
      if (facts.length < maxFacts) facts.push({ label: humanKey(key), value: scalar });
      continue;
    }
    if (items.length === 0 && Array.isArray(value) && value.length > 0) {
      const names = value.flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        const r = asRecord(entry);
        const label = r ? str(r.name) ?? str(r.title) ?? str(r.label) : null;
        return label ? [label] : [];
      });
      if (names.length) items = names.length > maxItems ? [...names.slice(0, maxItems), `+${names.length - maxItems} more`] : names;
    }
  }
  if (facts.length === 0 && items.length === 0) return null;
  return { kind: 'summary', title, facts, items, note: null };
}

/**
 * The card for one executed tool, or null when the result is better shown as
 * its one-line summary (a failure, a write that only returned an id, a read
 * that found nothing). An explicit `card` on the result wins when it is valid.
 */
export function cardFromToolResult(name: string, args: unknown, result: unknown, ctx: CardContext = {}): ResultCard | null {
  const r = asRecord(result);
  if (!r || r.ok === false) return null;
  const explicit = parseResultCard(r.card) ?? (asRecord(r.data) ? parseResultCard((r.data as Rec).card) : null);
  if (explicit) return explicit;
  const data = toolResultData(result);
  if (!data) return null;
  const title = str(r.summary) ?? 'Done';
  const canonical = canonicalToolName(name);
  const input = asRecord(args) ?? {};

  switch (canonical) {
    case 'meals.planWeek':
      return mealPlanCard(title, records(data.planned), { replaced: num(data.replaced), created_meals: num(data.created_meals) });
    case 'meals.getMealPlan':
      return mealPlanCard(title, records(data.slots), { week_start: str(data.week_start) });
    case 'meals.setSlot':
      return mealPlanCard(title, [data], {});
    case 'calendar.findConflicts': {
      const conflicts = records(data.conflicts).map((c) => ({
        when: str(c.when) ?? '',
        titles: strings(c.titles),
        member: memberName(ctx, c.member_id),
        event_ids: strings(c.event_ids),
      }));
      return { kind: 'calendar_conflict', title, conflicts, href: '/dashboard/calendar' };
    }
    case 'finances.budgetVsActual':
    case 'finances.comparePeriods':
    case 'finances.spendingByCategory':
      return budgetCard(title, canonical, data, ctx);
    case 'trips.computeReadiness':
      return readinessCard(title, data);
    case 'trips.buildPlan':
    case 'trips.createPackingList':
    case 'trips.commitmentConflicts':
    case 'trips.getTrip':
    case 'trips.findOrCreateVacation':
      return vacationCard(title, canonical, data, input, ctx);
    case 'groceries.addItems':
    case 'groceries.addFromMealPlan':
    case 'groceries.listOpen':
      return groceryCard(title, data);
    case 'tasks.searchTodos':
    case 'tasks.listOpenChores':
      return taskGroupCard(title, data, ctx);
    default:
      // A result that points at a run is shown as the run card the client
      // builds from the `run` event; a summary of its bookkeeping fields on
      // top would be a second, emptier card for the same thing.
      return runIdFromToolResult(result) ? null : summaryCardFromData(title, data);
  }
}
