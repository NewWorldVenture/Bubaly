// lib/ai/context/builder.ts — assemble the authorised household context for
// one request (§2, §27), under a budget, with an audit trail.
//
// The shape of a build:
//   1. decide which slices the intent needs (`INTENT_SLICES`, or the caller's
//      explicit list) and drop the ones the viewer may not see (`policy.ts`);
//   2. load the header (family name, zone, the roster) once, because every
//      slice resolves names against it;
//   3. run the surviving slices in parallel — each is a bounded loader over
//      the domain services, and each fences its own row-derived strings;
//   4. render under the char budget with a stable priority (`render.ts`);
//   5. persist: the full snapshot on `ai_request_context` (readable by the
//      requester and managers only), counts on `ai_requests.context_stats`.
//
// FAIL-CLOSED: if any slice the intent asked for cannot be read, the build
// fails rather than returning a partial picture. A planner that is told the
// calendar is empty because the calendar read failed will double-book the
// family with total confidence; "Could not load the calendar" is the honest
// answer. Slices that have optional sources (the proactive report) degrade
// internally and say so in their lines.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import { getMembers, getPreferences } from '@/lib/services/family';
import { dayKeyInTz, scopeNow, zonedDayBoundsMs } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { INTENT_SLICES, isSliceName, type IntentKey, type SliceName } from './intents';
import { applySlicePolicy, viewerFor, type SliceDefinition, type SliceEnv, type SliceResult } from './policy';
import { DEFAULT_CONTEXT_BUDGET_CHARS, renderContext, type RenderSection } from './render';
import { activitiesSlice } from './slices/activities';
import { documentsSlice } from './slices/documents';
import { foodSlice } from './slices/food';
import { homeSlice } from './slices/home';
import { memorySlice } from './slices/memory';
import { moneySlice, DEFAULT_CURRENCY } from './slices/money';
import { peopleSlice } from './slices/people';
import { proactiveSlice } from './slices/proactive';
import { scheduleSlice } from './slices/schedule';
import { shoppingSlice } from './slices/shopping';
import { tasksSlice } from './slices/tasks';
import { travelSlice } from './slices/travel';
import { vendorsSlice } from './slices/vendors';

export type { IntentKey, SliceName } from './intents';

const SLICES: Record<SliceName, SliceDefinition> = {
  people: peopleSlice,
  schedule: scheduleSlice,
  activities: activitiesSlice,
  food: foodSlice,
  shopping: shoppingSlice,
  tasks: tasksSlice,
  money: moneySlice,
  home: homeSlice,
  vendors: vendorsSlice,
  travel: travelSlice,
  documents: documentsSlice,
  memory: memorySlice,
  proactive: proactiveSlice,
};

/** The app's locale until families carry one; the header states it so the model formats dates the way the family reads them. */
const DEFAULT_LOCALE = 'en-US';

const DAY_MS = 86_400_000;

export type ContextHeader = {
  familyName: string;
  tz: string;
  locale: string;
  currency: string;
  nowIso: string;
  /** YYYY-MM-DD in the family's zone — what "today" means for every window. */
  todayKey: string;
  viewerRole: string;
  viewerName: string | null;
};

export type ContextBundle = {
  header: ContextHeader;
  /** Structured, already-redacted data per slice name. */
  slices: Record<string, unknown>;
  /** Counts per slice plus render stats; persisted on `ai_requests.context_stats`. */
  stats: Record<string, number>;
  /** Slice names withheld from this viewer by policy. */
  sensitiveOmitted: string[];
  /** Prompt-ready rendering, untrusted content fenced, within `budgetChars`. */
  text: string;
};

export type BuildContextOptions = {
  intent: IntentKey;
  /** Override the intent's slice list; unknown names are ignored, policy still applies. */
  slices?: string[];
  budgetChars?: number;
  /** When set, the snapshot is persisted for this request. */
  requestId?: string | null;
  pageContext?: { module?: string; entityIds?: string[] } | null;
};

/** The family header lines that open every prompt. Exported so callers can render a bundle their own way. */
export function headerLines(header: ContextHeader): string[] {
  let nowLocal = header.nowIso;
  try {
    nowLocal = new Intl.DateTimeFormat(header.locale, {
      timeZone: header.tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(header.nowIso));
  } catch {
    // An invalid zone or locale must not take the prompt down; the ISO instant still says when it is.
  }
  return [
    `Family: ${header.familyName}`,
    `Time zone: ${header.tz}. Today is ${header.todayKey}; local date/time now: ${nowLocal}.`,
    `Locale ${header.locale}, currency ${header.currency}.`,
    `Asking: ${header.viewerName ?? 'the system'} (${header.viewerRole}).`,
  ];
}

function resolveSliceNames(opts: BuildContextOptions): SliceName[] {
  if (opts.slices?.length) {
    const named = opts.slices.filter(isSliceName);
    // `people` is the one slice nothing works without: names, roles, who is asking.
    return named.includes('people') ? named : ['people', ...named];
  }
  return INTENT_SLICES[opts.intent] ?? INTENT_SLICES.other;
}

/**
 * Build the bundle. Returns `ok:false` with a human-readable error when the
 * header or any requested slice cannot be read (see the fail-closed note).
 */
export async function buildContext(scope: ServiceScope, opts: BuildContextOptions): Promise<ServiceResult<ContextBundle>> {
  const now = scopeNow(scope);
  const viewer = viewerFor(scope);
  const requested = resolveSliceNames(opts);
  const { allowed, omitted } = applySlicePolicy(requested, viewer);

  const [prefs, members] = await Promise.all([getPreferences(scope), getMembers(scope)]);
  if (!prefs.ok) return prefs;
  if (!members.ok) return members;

  const tz = scope.tz || prefs.data.timezone;
  const todayKey = dayKeyInTz(now, tz);
  const dayStart = zonedDayBoundsMs(todayKey, tz).start;
  const env: SliceEnv = {
    now,
    tz,
    todayKey,
    weekFromIso: new Date(Math.min(now.getTime(), dayStart)).toISOString(),
    weekToIso: new Date(dayStart + 7 * DAY_MS).toISOString(),
    viewer,
    members: members.data,
    pageContext: opts.pageContext ?? null,
  };
  const viewerMember = scope.memberId ? members.data.find((m) => m.id === scope.memberId) ?? null : null;
  const header: ContextHeader = {
    familyName: prefs.data.familyName,
    tz,
    locale: DEFAULT_LOCALE,
    currency: DEFAULT_CURRENCY,
    nowIso: now.toISOString(),
    todayKey,
    viewerRole: scope.role,
    viewerName: viewerMember?.displayName ?? null,
  };

  const results = await Promise.all(allowed.map(async (name): Promise<{ name: SliceName; result: ServiceResult<SliceResult> }> => {
    try {
      return { name, result: await SLICES[name].load(scope, env) };
    } catch (error) {
      // A slice that throws (a fake client without a method, a bug) is still a
      // failed read for the purposes of fail-closed — but with a log line that
      // names the slice, because "Something went wrong" is not debuggable.
      console.error(`[ai-context] slice "${name}" threw`, error);
      return { name, result: fail(describeDbError(error, `Could not load the ${name} context.`), { code: SERVICE_CODES.db }) };
    }
  }));

  const slices: Record<string, unknown> = {};
  const stats: Record<string, number> = {};
  const sections: RenderSection[] = [];
  for (const { name, result } of results) {
    if (!result.ok) {
      console.error(`[ai-context] slice "${name}" failed for intent "${opts.intent}"`, result.error);
      return fail(result.error, { code: result.code ?? SERVICE_CODES.db, retryable: result.retryable });
    }
    slices[name] = result.data.data;
    stats[`${name}_count`] = result.data.count;
    sections.push({ name, title: SLICES[name].title, lines: result.data.lines });
  }

  const rendered = renderContext({
    preamble: [...headerLines(header), UNTRUSTED_CONTENT_RULE],
    sections,
    budgetChars: opts.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS,
  });
  Object.assign(stats, rendered.stats);
  stats.slices_loaded = allowed.length;
  stats.slices_omitted = omitted.length;

  const bundle: ContextBundle = {
    header,
    slices,
    stats,
    sensitiveOmitted: omitted,
    text: rendered.text,
  };

  if (opts.requestId) await persistSnapshot(scope, opts, bundle);
  return ok(bundle);
}

/**
 * The client that may write the AI ledgers: the service client, because a
 * member's client has no INSERT/UPDATE policy on `ai_request_context` or
 * `ai_requests` (0250). Resolved lazily so importing the builder never
 * requires the service-role environment (tests, tooling).
 */
async function ledgerFor(scope: ServiceScope): Promise<SupabaseClient<Database>> {
  if (scope.actorKind === 'system') return scope.db;
  const { createServiceClient } = await import('@/lib/supabase/server');
  return createServiceClient();
}

/**
 * Snapshot + stats. Never fatal: the request already exists and the answer
 * is still correct without the audit copy, so a write failure is logged and
 * the build proceeds — the same rule `lib/ai/runs/store.ts createRequest`
 * applies to the snapshot it writes.
 */
async function persistSnapshot(scope: ServiceScope, opts: BuildContextOptions, bundle: ContextBundle): Promise<void> {
  const requestId = opts.requestId;
  if (!requestId) return;
  try {
    const db = await ledgerFor(scope);
    const snapshot = {
      intent: opts.intent,
      header: bundle.header,
      slices: bundle.slices,
      pageContext: opts.pageContext ?? null,
    } as unknown as Json;
    const { error: snapshotError } = await db
      .from('ai_request_context')
      .upsert({ request_id: requestId, family_id: scope.familyId, snapshot, sensitive_omitted: bundle.sensitiveOmitted }, { onConflict: 'request_id' });
    if (snapshotError) console.error('[ai-context] snapshot persistence failed', snapshotError);

    const { error: statsError } = await db
      .from('ai_requests')
      .update({ context_stats: bundle.stats as Json, interpreted_intent: opts.intent })
      .eq('id', requestId)
      .eq('family_id', scope.familyId);
    if (statsError) console.error('[ai-context] context_stats persistence failed', statsError);
  } catch (error) {
    console.error('[ai-context] snapshot persistence threw', error);
  }
}
