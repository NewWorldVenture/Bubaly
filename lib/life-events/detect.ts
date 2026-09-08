// lib/life-events/detect.ts — which transition this household is already in
// (M34). PURE: a snapshot in, a ranked list of proposals out. No I/O, no
// `server-only`, so `tests/life-events-detect.test.ts` can pin every rule.
//
// WHY detection rather than a menu: the six playbooks were only ever reachable
// by a family who already knew which one they wanted, which means the family
// who most needs "School Start" — the one who has not thought about September
// yet — never sees it. Every rule here reads something the household ALREADY
// put in Bubaly (a term date, a pet row, a project in planning, a fact about a
// parent), so the proposal can always say why, in the family's own data.
//
// Honesty rules that shape the output:
//   - every suggestion carries the evidence it was derived from, so the UI can
//     say "because Emma's term starts on 2 September" rather than "we think";
//   - a transition the family is already running (an active plan on that key)
//     is never proposed again;
//   - nothing here claims Bubaly DID anything. A suggestion is an offer.

import { LIFE_EVENT_TEMPLATES, addDays, type LifeEventTemplate } from './templates';

/** Within this many days of a term start, "get ready for school" is real work rather than a nag. */
export const SCHOOL_START_WINDOW_DAYS = 45;
/** A pet added this recently is a pet the family is still settling in. */
export const NEW_PET_WINDOW_DAYS = 7;
/** How far ahead the holiday season is worth proposing. */
export const HOLIDAY_WINDOW_DAYS = 60;
/** Camp is booked in the spring for the summer; propose it inside this window before the first summer day. */
export const CAMP_WINDOW_DAYS = 120;

/** The household snapshot the detector reads. Every field is optional so a caller can pass only what it has. */
export type LifeEventSignals = {
  /** Today, family-local, `YYYY-MM-DD`. */
  todayKey: string;
  /** School term / year starts already on file: `{ label, startKey }`. */
  termStarts?: { label: string; startKey: string }[];
  /** Pets on file with the day the row was created (`YYYY-MM-DD`). */
  pets?: { name: string; createdKey: string }[];
  /** Home projects with their status; `planning`, `idea` and `quoting` are the ones not yet under way. */
  homeProjects?: { title: string; status: string }[];
  /** Things the family told Bubaly to remember — used only for the care signal. */
  facts?: { label: string; value: string }[];
  /**
   * Template keys the family has a LIVE (`status = 'active'`) plan for; never
   * proposed again. Completed and archived plans must not be listed here —
   * school_start, camp and holidays come round every year, and a finished plan
   * in this set would suppress the next one for ever.
   */
  activePlanKeys?: string[];
};

export type LifeEventSuggestion = {
  templateKey: string;
  /** The template's English title, for callers that do not want to look it up. */
  title: string;
  /** Why, in one sentence of English — the fallback when no catalogue is loaded. */
  reason: string;
  /** The i18n key for the same sentence, with `reasonParams` filled in. */
  reasonKey: string;
  reasonParams: Record<string, string | number>;
  /** The date to launch the plan against, when the signal implies one. */
  eventDate: string | null;
  /** 0–100. Higher is more urgent; the list is returned sorted by it. */
  score: number;
};

const BY_KEY = new Map<string, LifeEventTemplate>(LIFE_EVENT_TEMPLATES.map((t) => [t.key, t]));

function titleFor(key: string): string {
  return BY_KEY.get(key)?.title ?? key;
}

/** Whole days from `fromKey` to `toKey` (negative when `toKey` is in the past). */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toKey.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((to - from) / 86_400_000);
}

/** A fact that reads like an ageing parent the family is starting to care for. */
const PARENT_CARE_RE = /\b(mum|mom|mother|dad|father|grandma|grandpa|grandmother|grandfather|nan|nana|parent|in-law)\b/i;
const CARE_RE = /\b(care|carer|caregiver|caring|assisted living|nursing|dementia|alzheimer|hospice|mobility|fall|falls|medication|home help)\b/i;

/** The holidays this detector knows, as `MM-DD` in the year they fall. */
const HOLIDAY_DATES = ['12-25', '11-27'] as const;

/** The first day of the summer break, roughly, as `MM-DD`; camp is booked back from it. */
const SUMMER_START = '06-15';

function nextOccurrence(todayKey: string, monthDay: string): string {
  const year = Number(todayKey.slice(0, 4));
  const thisYear = `${year}-${monthDay}`;
  return daysBetweenKeys(todayKey, thisYear) >= 0 ? thisYear : `${year + 1}-${monthDay}`;
}

/**
 * Rank the transitions this household looks like it is heading into.
 *
 * Deterministic and total: the same snapshot always produces the same list, in
 * the same order, and an empty snapshot produces an empty list rather than a
 * generic set of suggestions nobody asked for.
 */
export function detectLifeEvents(signals: LifeEventSignals): LifeEventSuggestion[] {
  const today = signals.todayKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const running = new Set(signals.activePlanKeys ?? []);
  const out: LifeEventSuggestion[] = [];
  const propose = (s: LifeEventSuggestion) => {
    if (running.has(s.templateKey)) return;
    if (out.some((existing) => existing.templateKey === s.templateKey)) return;
    out.push(s);
  };

  // 1. A term start already on file, inside the window.
  for (const term of signals.termStarts ?? []) {
    const days = daysBetweenKeys(today, term.startKey);
    if (!Number.isFinite(days) || days < 0 || days > SCHOOL_START_WINDOW_DAYS) continue;
    propose({
      templateKey: 'school_start',
      title: titleFor('school_start'),
      reason: `${term.label} starts in ${days} ${days === 1 ? 'day' : 'days'}.`,
      reasonKey: 'lifeEventsDetect.termStartsInDays',
      reasonParams: { label: term.label, days },
      eventDate: term.startKey,
      score: Math.round(90 - (days / SCHOOL_START_WINDOW_DAYS) * 30),
    });
  }

  // 2. A pet added in the last week is a pet still being settled in.
  for (const pet of signals.pets ?? []) {
    const age = daysBetweenKeys(pet.createdKey, today);
    if (!Number.isFinite(age) || age < 0 || age > NEW_PET_WINDOW_DAYS) continue;
    propose({
      templateKey: 'new_pet',
      title: titleFor('new_pet'),
      reason: `${pet.name} joined the family this week.`,
      reasonKey: 'lifeEventsDetect.petJoinedThisWeek',
      reasonParams: { name: pet.name },
      eventDate: pet.createdKey,
      score: 85 - age,
    });
  }

  // 3. A project that is being thought about but has not started.
  for (const project of signals.homeProjects ?? []) {
    if (!['planning', 'idea', 'quoting'].includes(project.status)) continue;
    propose({
      templateKey: 'renovation',
      title: titleFor('renovation'),
      reason: `"${project.title}" is still at the planning stage.`,
      reasonKey: 'lifeEventsDetect.projectStillPlanning',
      reasonParams: { title: project.title },
      eventDate: null,
      score: project.status === 'quoting' ? 70 : 60,
    });
  }

  // 4. The family has told Bubaly something about caring for a parent.
  for (const fact of signals.facts ?? []) {
    const text = `${fact.label} ${fact.value}`;
    if (!PARENT_CARE_RE.test(text) || !CARE_RE.test(text)) continue;
    propose({
      templateKey: 'aging_parent',
      title: titleFor('aging_parent'),
      reason: `You told Bubaly about "${fact.label}".`,
      reasonKey: 'lifeEventsDetect.becauseYouToldBubaly',
      reasonParams: { label: fact.label },
      eventDate: null,
      score: 55,
    });
  }

  // 5. The holiday season, once it is close enough to act on.
  for (const monthDay of HOLIDAY_DATES) {
    const date = nextOccurrence(today, monthDay);
    const days = daysBetweenKeys(today, date);
    if (!Number.isFinite(days) || days < 0 || days > HOLIDAY_WINDOW_DAYS) continue;
    propose({
      templateKey: 'holidays',
      title: titleFor('holidays'),
      reason: `The holidays are ${days} ${days === 1 ? 'day' : 'days'} away.`,
      reasonKey: 'lifeEventsDetect.holidaysAreDaysAway',
      reasonParams: { days },
      eventDate: date,
      score: Math.round(75 - (days / HOLIDAY_WINDOW_DAYS) * 25),
    });
  }

  // 6. Camp, while there are still places. Only for a household with children
  //    on file — a term start is the cheapest proof of that.
  if ((signals.termStarts ?? []).length > 0) {
    const summer = nextOccurrence(today, SUMMER_START);
    const days = daysBetweenKeys(today, summer);
    if (Number.isFinite(days) && days >= 0 && days <= CAMP_WINDOW_DAYS) {
      propose({
        templateKey: 'camp',
        title: titleFor('camp'),
        reason: `The summer break starts in about ${days} ${days === 1 ? 'day' : 'days'}; camps fill up first.`,
        reasonKey: 'lifeEventsDetect.summerStartsInDays',
        reasonParams: { days },
        eventDate: summer,
        score: Math.round(65 - (days / CAMP_WINDOW_DAYS) * 25),
      });
    }
  }

  return out.sort((a, b) => b.score - a.score || a.templateKey.localeCompare(b.templateKey));
}

/** The date a proposal should launch against: its own, else the template's default lead time. */
export function launchDateFor(suggestion: LifeEventSuggestion, todayKey: string): string {
  if (suggestion.eventDate) return suggestion.eventDate;
  const template = BY_KEY.get(suggestion.templateKey);
  return addDays(todayKey, template?.defaultLeadDays ?? 30);
}
