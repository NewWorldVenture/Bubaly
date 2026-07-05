// lib/operating-index/orchestrator.ts — the AI Operating Layer's daily reasoning,
// expressed as pure functions (pillar #1). It answers the five questions a family
// chief of staff would ask each morning, reading the same household state the
// Family Operating Index scores plus a small "tomorrow" slice:
//
//   1. What's most likely to go wrong tomorrow?
//   2. What can be completed automatically today?
//   3. Who is overloaded this week?
//   4. What should the family decide next?
//   5. What information is missing before an important event?
//
// No Supabase, no DOM — the server assembles the inputs, this decides the answers.
// Deterministic and fully unit-testable. Honest by construction: a quiet day
// returns "clear" answers, never invented risk.

import type { MemberLoad } from './score';

/** One event on the horizon the orchestrator reasons over. */
export interface DayEvent {
  id: string;
  title: string;
  startsAt: string;        // ISO
  endsAt: string | null;   // ISO
  allDay: boolean;
  assigneeId: string | null;
  location: string | null;
  /** True when the event's category implies a place you travel to (needs a location + buffer). */
  needsLocation: boolean;
}

/** A named item to act on, optionally deep-linked. */
export interface OrchestratorItem {
  label: string;
  href?: string;
}

export type QuestionId = 'go_wrong' | 'auto_today' | 'overloaded' | 'decide_next' | 'missing_info';

export interface OrchestratorAnswer {
  id: QuestionId;
  question: string;
  /** 'clear' = nothing to flag (calm); 'attention' = there's something to look at. */
  status: 'clear' | 'attention';
  headline: string;
  items: OrchestratorItem[];
}

export interface OrchestratorReport {
  answers: OrchestratorAnswer[];
  /** True when every question is 'clear' — a genuinely calm day. */
  allClear: boolean;
  generatedAt: string;
}

export interface OrchestratorInput {
  /** Tomorrow's timed + all-day events (the "what could go wrong" horizon). */
  tomorrowEvents: DayEvent[];
  /** Reversible, ≥90%-confidence autopilot actions actionable today. */
  autoCompletable: OrchestratorItem[];
  /** Most-loaded member this week, from the FOI engine (`mostLoaded`). */
  overloaded: MemberLoad | null;
  /** Decisions waiting on the family: approvals + open votes. */
  pendingApprovals: OrchestratorItem[];
  openVotes: number;
  /** Upcoming important events missing a needed location. */
  missingInfo: OrchestratorItem[];
}

const MIN = 60_000;
/** Same-person events closer than this back-to-back are a "tight turnaround". */
const TIGHT_GAP_MIN = 15;

function overlaps(a: DayEvent, b: DayEvent): boolean {
  const as = Date.parse(a.startsAt), bs = Date.parse(b.startsAt);
  const ae = a.endsAt ? Date.parse(a.endsAt) : as + 60 * MIN;
  const be = b.endsAt ? Date.parse(b.endsAt) : bs + 60 * MIN;
  return as < be && bs < ae; // half-open
}

/** Risks that make tomorrow likely to go sideways. Deterministic. */
function goWrongTomorrow(events: DayEvent[]): OrchestratorItem[] {
  const timed = events.filter((e) => !e.allDay && !Number.isNaN(Date.parse(e.startsAt)));
  const risks: OrchestratorItem[] = [];
  const seenPair = new Set<string>();

  // Same-person overlaps + tight turnarounds.
  const byAssignee = new Map<string, DayEvent[]>();
  for (const e of timed) {
    if (!e.assigneeId) continue;
    (byAssignee.get(e.assigneeId) ?? byAssignee.set(e.assigneeId, []).get(e.assigneeId)!).push(e);
  }
  for (const list of byAssignee.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        const key = [a.id, b.id].sort().join('|');
        if (overlaps(a, b) && !seenPair.has(key)) {
          seenPair.add(key);
          risks.push({ label: `“${a.title}” overlaps “${b.title}”`, href: '/dashboard/conflicts' });
        }
      }
      if (i > 0) {
        const prev = sorted[i - 1], cur = sorted[i];
        const prevEnd = prev.endsAt ? Date.parse(prev.endsAt) : Date.parse(prev.startsAt) + 60 * MIN;
        const gap = (Date.parse(cur.startsAt) - prevEnd) / MIN;
        if (gap >= 0 && gap < TIGHT_GAP_MIN) {
          risks.push({ label: `Tight turnaround: “${prev.title}” → “${cur.title}” (${Math.round(gap)} min)`, href: '/dashboard/calendar' });
        }
      }
    }
  }

  // Events with no owner and events that need a location but have none.
  const unowned = timed.filter((e) => !e.assigneeId).length;
  if (unowned > 0) risks.push({ label: `${unowned} event${unowned > 1 ? 's' : ''} tomorrow with no owner`, href: '/dashboard/calendar' });
  const noLocation = timed.filter((e) => e.needsLocation && !e.location).length;
  if (noLocation > 0) risks.push({ label: `${noLocation} event${noLocation > 1 ? 's' : ''} missing a location`, href: '/dashboard/calendar' });

  return risks;
}

/**
 * Answer the five orchestrator questions. Pure and deterministic given inputs.
 */
export function orchestrate(input: OrchestratorInput, now: Date = new Date()): OrchestratorReport {
  const goWrong = goWrongTomorrow(input.tomorrowEvents);

  const decisions: OrchestratorItem[] = [...input.pendingApprovals];
  if (input.openVotes > 0) decisions.push({ label: `${input.openVotes} open family vote${input.openVotes > 1 ? 's' : ''}`, href: '/dashboard/voting' });

  const answers: OrchestratorAnswer[] = [
    {
      id: 'go_wrong',
      question: 'What’s most likely to go wrong tomorrow?',
      status: goWrong.length ? 'attention' : 'clear',
      headline: goWrong.length
        ? `${goWrong.length} thing${goWrong.length > 1 ? 's' : ''} could trip up tomorrow.`
        : 'Tomorrow looks clear — no conflicts or gaps.',
      items: goWrong.slice(0, 5),
    },
    {
      id: 'auto_today',
      question: 'What can be handled automatically today?',
      status: input.autoCompletable.length ? 'attention' : 'clear',
      headline: input.autoCompletable.length
        ? `${input.autoCompletable.length} task${input.autoCompletable.length > 1 ? 's' : ''} Autopilot can take off your plate.`
        : 'Nothing to auto-handle right now.',
      items: input.autoCompletable.slice(0, 5),
    },
    {
      id: 'overloaded',
      question: 'Who’s overloaded this week?',
      status: input.overloaded ? 'attention' : 'clear',
      headline: input.overloaded
        ? `${input.overloaded.name} is carrying the most this week.`
        : 'The load is spread evenly this week.',
      items: input.overloaded
        ? [{ label: `${input.overloaded.upcoming} event${input.overloaded.upcoming === 1 ? '' : 's'} · ${input.overloaded.openTasks} open task${input.overloaded.openTasks === 1 ? '' : 's'}`, href: '/dashboard/family' }]
        : [],
    },
    {
      id: 'decide_next',
      question: 'What should the family decide next?',
      status: decisions.length ? 'attention' : 'clear',
      headline: decisions.length
        ? `${decisions.length} decision${decisions.length > 1 ? 's' : ''} waiting on the family.`
        : 'No decisions are waiting.',
      items: decisions.slice(0, 5),
    },
    {
      id: 'missing_info',
      question: 'What info is missing before an important event?',
      status: input.missingInfo.length ? 'attention' : 'clear',
      headline: input.missingInfo.length
        ? `${input.missingInfo.length} upcoming event${input.missingInfo.length > 1 ? 's are' : ' is'} missing details.`
        : 'Upcoming events have what they need.',
      items: input.missingInfo.slice(0, 5),
    },
  ];

  return {
    answers,
    allClear: answers.every((a) => a.status === 'clear'),
    generatedAt: now.toISOString(),
  };
}
