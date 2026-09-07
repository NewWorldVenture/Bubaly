// What Bubaly already noticed: the six-question reasoning report (what
// matters most, what was forgotten, who needs help…), the live behavioural
// signals, the household counts behind the stress score, and the suggestions
// and recommendations still waiting for a person. This is the slice that lets
// "what am I forgetting?" be answered from evidence rather than guessed.
//
// `gatherSignalsResult` reads through the request-bound Supabase client and so
// only works inside a request; when a background run builds context there is
// no request, the call throws, and the counts are simply reported as
// unavailable. The reasoning report degrades per source on its own and is
// always returned.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { gatherSignalsResult, type FamilySignals } from '@/lib/family/signals';
import { detectLifeEvents, SCHOOL_START_WINDOW_DAYS, type LifeEventSuggestion } from '@/lib/life-events/detect';
import { loadReasoningReport } from '@/lib/reasoning/engine-server';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import type { SliceDefinition } from '../policy';

const MAX_ITEMS_PER_ANSWER = 3;
const MAX_SUGGESTIONS = 8;
const MAX_SIGNALS = 8;

/**
 * The reasoning report and the suggestion queues are household-wide and can
 * mention budgets, bills or documents. Those areas are manager-only (§4,
 * `SLICE_ACCESS`), so for anyone else an item that touches them is dropped
 * here — the same rule the money and documents slices enforce by not loading.
 */
const MANAGER_ONLY_RE = /\b(budget|bill|bills|spend|spending|money|financ|transaction|account|salary|income|document|passport|insurance|tax|vault|subscription)\b/i;

function managerOnlyText(...parts: (string | null | undefined)[]): boolean {
  return MANAGER_ONLY_RE.test(parts.filter(Boolean).join(' '));
}

export type ProactiveSliceData = {
  counts: FamilySignals['counts'] | null;
  stress: { score: number; level: string } | null;
  report: {
    allClear: boolean;
    answers: { id: string; question: string; status: string; headline: string; items: { title: string; detail: string | null }[] }[];
    readErrors: string[];
  };
  signals: { kind: string; title: string; detail: string | null; score: number }[];
  autopilot: { id: string; title: string; detail: string | null; urgency: number; actionLabel: string | null }[];
  recommendations: { id: string; title: string; body: string | null; priority: string; category: string }[];
  /** M34: transitions the household's own rows say are coming, with the evidence. */
  lifeEvents: LifeEventSuggestion[];
  /** Items dropped for a non-manager because they touched money or documents. */
  withheld: number;
};

/** School events whose title reads like the start of a term or a school year — the same rule the page uses. */
const TERM_START_RE = /\b(term|semester|school year|first day|back[- ]to[- ]school|start of school|orientation)\b/i;
/** How many transitions reach the prompt; more than this is not proactive, it is noise. */
const MAX_LIFE_EVENTS = 3;

async function loadSignals(familyId: string): Promise<FamilySignals | null> {
  try {
    const result = await gatherSignalsResult(familyId);
    if (result.error) {
      console.error('[ai-context:proactive] family signal counts failed', result.error);
      return null;
    }
    return result.data;
  } catch (error) {
    // Expected outside a request (no cookies to build the client from); the
    // reasoning report still carries the substance, so this degrades.
    console.error('[ai-context:proactive] family signal counts unavailable', error);
    return null;
  }
}

export const proactiveSlice: SliceDefinition = {
  name: 'proactive',
  title: 'What Bubaly has noticed',
  async load(scope, env) {
    // M34: the life-event signals ride along here because "what Bubaly has
    // noticed" is exactly where a coming transition belongs — and because the
    // planner needs it in the same slice a proactive intent already loads.
    const todayKey = env.now.toISOString().slice(0, 10);
    const termHorizon = new Date(env.now.getTime() + SCHOOL_START_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const petSince = new Date(env.now.getTime() - 8 * 86_400_000).toISOString().slice(0, 10);

    const [signals, report, liveSignals, autopilot, recommendations, terms, pets, projects, plans] = await Promise.all([
      loadSignals(scope.familyId),
      loadReasoningReport(scope.db, scope.familyId, env.now),
      scope.db.from('family_signals').select('kind, title, detail, score').eq('family_id', scope.familyId).eq('status', 'active').order('score', { ascending: false }).limit(MAX_SIGNALS),
      scope.db.from('autopilot_suggestions').select('id, title, detail, urgency, action_label').eq('family_id', scope.familyId).eq('status', 'open').order('urgency', { ascending: false }).limit(MAX_SUGGESTIONS),
      scope.db.from('family_ai_recommendations').select('id, title, body, priority, category').eq('family_id', scope.familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(MAX_SUGGESTIONS),
      scope.db.from('school_events').select('title, starts_at').eq('family_id', scope.familyId).gte('starts_at', `${todayKey}T00:00:00Z`).lte('starts_at', `${termHorizon}T23:59:59Z`).limit(50),
      scope.db.from('pets').select('name, created_at').eq('family_id', scope.familyId).gte('created_at', `${petSince}T00:00:00Z`).limit(20),
      scope.db.from('home_projects').select('title, status').eq('family_id', scope.familyId).in('status', ['idea', 'planning', 'quoting']).limit(20),
      // ACTIVE only — a completed plan is history, not a live plan, and
      // feeding it to `activePlanKeys` would permanently suppress the annual
      // transitions (holidays, school_start, camp) the detector exists for.
      scope.db.from('life_event_plans').select('template_key').eq('family_id', scope.familyId).eq('status', 'active').limit(50),
    ]);
    const readError = liveSignals.error ?? autopilot.error ?? recommendations.error ?? terms.error ?? pets.error ?? projects.error ?? plans.error;
    if (readError) {
      console.error('[ai-context:proactive] suggestion read failed', readError);
      return fail(describeDbError(readError, "Could not load Bubaly's suggestions."), { code: SERVICE_CODES.db });
    }

    const lifeEvents = detectLifeEvents({
      todayKey,
      termStarts: (terms.data ?? []).filter((e) => TERM_START_RE.test(e.title ?? '')).map((e) => ({ label: e.title, startKey: String(e.starts_at).slice(0, 10) })),
      pets: (pets.data ?? []).map((p) => ({ name: p.name, createdKey: String(p.created_at).slice(0, 10) })),
      homeProjects: (projects.data ?? []).map((p) => ({ title: p.title, status: p.status })),
      activePlanKeys: (plans.data ?? []).map((p) => p.template_key),
    }).slice(0, MAX_LIFE_EVENTS);

    const canManage = env.viewer.canManage;
    let withheld = 0;
    const keep = (...parts: (string | null | undefined)[]): boolean => {
      if (canManage || !managerOnlyText(...parts)) return true;
      withheld += 1;
      return false;
    };

    const data: ProactiveSliceData = {
      counts: signals?.counts ?? null,
      stress: signals ? { score: signals.stress.score, level: signals.stress.level } : null,
      report: {
        allClear: report.allClear,
        answers: report.answers.map((a) => ({
          id: a.id, question: a.question, status: a.status,
          headline: keep(a.headline) ? a.headline : 'Some items are only shown to the adults who manage the family.',
          items: a.items
            .filter((i) => keep(i.title, i.detail, i.href))
            .slice(0, MAX_ITEMS_PER_ANSWER)
            .map((i) => ({ title: i.title, detail: i.detail ?? null })),
        })),
        readErrors: report.readErrors,
      },
      signals: (liveSignals.data ?? []).filter((s) => keep(s.kind, s.title, s.detail)).map((s) => ({ kind: s.kind, title: s.title, detail: s.detail, score: s.score })),
      autopilot: (autopilot.data ?? []).filter((s) => keep(s.title, s.detail, s.action_label)).map((s) => ({ id: s.id, title: s.title, detail: s.detail, urgency: s.urgency, actionLabel: s.action_label })),
      recommendations: (recommendations.data ?? []).filter((r) => keep(r.category, r.title, r.body)).map((r) => ({ id: r.id, title: r.title, body: r.body, priority: r.priority, category: r.category })),
      lifeEvents,
      withheld,
    };

    const lines: string[] = [];
    if (data.counts) {
      const c = data.counts;
      const bits = [
        `${c.eventsToday} event${c.eventsToday === 1 ? '' : 's'} today`,
        `${c.overdueTasks} overdue task${c.overdueTasks === 1 ? '' : 's'}`,
        `${c.dueTodayTasks} due today`,
        ...(canManage ? [`${c.overdueBills} overdue bill${c.overdueBills === 1 ? '' : 's'}`, `${c.billsDueSoon} due soon`] : []),
        `${c.homeworkDueSoon} homework due soon`,
        `${c.sportsThisWeek} sports this week`,
        `${c.plannedMeals} meals planned`,
      ];
      if (c.emptyGrocery) bits.push('grocery list empty');
      lines.push(`- Today by the numbers: ${bits.join(', ')}${data.stress ? `; household stress ${data.stress.level} (${data.stress.score}/100)` : ''}`);
    }
    if (data.report.allClear) {
      lines.push('- Reasoning check: all clear — nothing is being missed right now.');
    }
    for (const a of data.report.answers) {
      if (a.status !== 'attention') continue;
      const items = a.items.map((i) => fenceUntrusted('insight', i.detail ? `${i.title} — ${i.detail}` : i.title));
      lines.push(`- ${sanitizeUntrusted(a.question, 60)} ${fenceUntrusted('insight', a.headline)}${items.length ? `: ${items.join('; ')}` : ''}`);
    }
    for (const s of data.signals) {
      lines.push(`- Signal (${sanitizeUntrusted(s.kind, 30)}, ${Math.round(s.score)}): ${fenceUntrusted('signal', s.detail ? `${s.title} — ${s.detail}` : s.title)}`);
    }
    for (const s of data.autopilot) {
      lines.push(`- Waiting for a decision: ${fenceUntrusted('suggestion', s.detail ? `${s.title} — ${s.detail}` : s.title)}`);
    }
    for (const r of data.recommendations) {
      lines.push(`- Pending recommendation (${sanitizeUntrusted(r.category, 20)}): ${fenceUntrusted('recommendation', r.body ? `${r.title} — ${r.body}` : r.title)}`);
    }
    for (const s of data.lifeEvents) {
      lines.push(`- Coming transition (${sanitizeUntrusted(s.templateKey, 30)}${s.eventDate ? `, ${s.eventDate}` : ''}): ${fenceUntrusted('signal', `${s.title} — ${s.reason}`)}`);
    }
    if (data.report.readErrors.length) {
      lines.push(`- Some checks could not run (${data.report.readErrors.join(', ')}); do not assume those areas are clear.`);
    }

    const attention = data.report.answers.filter((a) => a.status === 'attention').length;
    return ok({ data, count: attention + data.signals.length + data.autopilot.length + data.recommendations.length + data.lifeEvents.length, lines });
  },
};
