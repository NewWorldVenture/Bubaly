// The school and sports front desk's first pass: decide whether an inbound
// family message is school work or sports work, what KIND of work it is, which
// child it is about, when it is due and what it costs.
//
// PURE AND DETERMINISTIC, and that is load-bearing rather than stylistic:
//
//   * no clock. A date written without a year ("Friday, September 14") cannot
//     be resolved without knowing what year it is, so the caller passes `now`
//     and the function resolves it from that. With no `now` the date is simply
//     not reported — inventing one would put a made-up deadline on a reminder.
//   * no I/O and no locale. The same message, roster and `now` produce the same
//     answer on a webhook, in a server action and in the browser, which is what
//     lets `tests/school-sports-classifier.test.ts` pin the whole behaviour
//     without a database.
//   * no storage. `family_inbox_messages` (0214) carries channel, direction,
//     from_addr, to_addr, subject, body, ai_summary, ai_intent, ai_handled,
//     status, provider_ref and occurred_at — and NOTHING ELSE. There is no
//     member_id, no linked_type/linked_id and no sub_intent column, so the
//     classification below is derived at READ TIME, every time, and never
//     written back. The one thing a row can say is `ai_handled`, and that is
//     therefore the only "we did something about this" claim any surface makes.
//
// WHAT IT DELIBERATELY REFUSES TO SAY: `domain` is null unless the text
// actually carries a school or sports signal, and `subKind` is null whenever
// `domain` is. A grocery receipt has amounts, a date and the word "due" on it;
// without a school or sports signal it stays unclassified rather than becoming
// a "fee" the family is told to pay.
//
// Client-safe on purpose: `lib/contact-center/routing.ts` (which the inbound
// webhooks use) and the desk card in the school module both import it, and
// neither may drag `server-only` in.

export type FrontDeskDomain = 'school' | 'sports';

export type FrontDeskSubKind = 'form' | 'fee' | 'gear' | 'transport' | 'schedule_change';

/** The columns of an inbox row this reads. All optional: a voice note has no subject. */
export type FrontDeskMessage = {
  subject?: string | null;
  body?: string | null;
  from_addr?: string | null;
};

/** `family_members` (0002), narrowed to what name matching needs. */
export type RosterMember = { id: string; display_name?: string | null };

/** `teams` (0006), narrowed. `member_id` is nullable there, so it is here. */
export type RosterTeam = {
  member_id?: string | null;
  team_name?: string | null;
  sport?: string | null;
  coach?: string | null;
};

/** `school_classes` (0006), narrowed. */
export type RosterClass = {
  member_id?: string | null;
  subject?: string | null;
  teacher?: string | null;
  school_name?: string | null;
};

export type FrontDeskClassification = {
  domain: FrontDeskDomain | null;
  subKind: FrontDeskSubKind | null;
  /** The child the message is about, when a roster row or a name in the text names one. */
  child?: { member_id: string; name: string };
  /** `YYYY-MM-DD`. Absent when the text states no date, or states one whose year cannot be known. */
  date?: string;
  /** `HH:MM`, 24-hour. Absent when the text states no time — never defaulted to one. */
  time?: string;
  /** Minor units of `currency`. Only ever set from an explicitly signed amount. */
  amount_cents?: number;
  currency?: 'USD' | 'EUR' | 'GBP';
  /** 0 when nothing matched. Never 1: this is a keyword pass, not a judgement. */
  confidence: number;
};

export type ClassifyOptions = {
  /**
   * ISO instant used ONLY to resolve a date written without a year, and to
   * decide whether such a date belongs to this year or the next. Omit it and
   * year-less dates are left unreported.
   */
  now?: string | null;
};

// ── signals ────────────────────────────────────────────────────────────────
// Each entry is one distinct signal. The COUNT of distinct matches picks the
// domain and feeds the confidence, so overlapping spellings of one idea belong
// in one entry rather than three.

const SCHOOL_SIGNALS: RegExp[] = [
  /\bschool(?:s|ing)?\b/i,
  /\b(?:pre|high|middle|elementary|primary|secondary|grammar)[-\s]school\b/i,
  /\bteachers?\b/i,
  /\bprincipal\b/i,
  /\bhomeroom\b/i,
  /\bclassrooms?\b/i,
  /\bhomework\b/i,
  /\breport cards?\b/i,
  /\bparent[-\s]teacher\b/i,
  /\bp\.?t\.?[ao]\.?\b/i,
  /\bfield trips?\b/i,
  /\bpermission slips?\b/i,
  /\bassembly\b/i,
  /\bsemester\b/i,
  /\bearly (?:dismissal|release)\b/i,
  /\bcafeteria\b/i,
  /\blunch (?:money|account|balance)\b/i,
  /\bsyllabus\b/i,
  /\bdetention\b/i,
  /\bback[-\s]to[-\s]school\b/i,
  /\b\d(?:st|nd|rd|th) grade\b/i,
  /\bschool bus\b/i,
  /\bparents?'? evening\b/i,
  /\btuition\b/i,
];

const SPORTS_SIGNALS: RegExp[] = [
  /\bpractices?\b/i,
  /\bcoach(?:es)?\b/i,
  /\bteams?\b/i,
  /\bgames?\b/i,
  /\b(?:home|away) (?:game|match|fixture)\b/i,
  /\btournaments?\b/i,
  /\bscrimmage\b/i,
  /\bplayoffs?\b/i,
  /\bleague\b/i,
  /\brosters?\b/i,
  /\bjerseys?\b/i,
  /\bcleats\b/i,
  /\bshin guards?\b/i,
  /\bmouth\s?guards?\b/i,
  /\bdugout\b/i,
  /\bswim meet\b/i,
  /\b(?:soccer|football|basketball|baseball|softball|hockey|volleyball|lacrosse|swimming|tennis|gymnastics|wrestling|cross country|rugby|cricket|netball|handball|water polo|karate|judo|track and field)\b/i,
];

/**
 * Sender addresses that say "school" on their own. A message from
 * office@lincoln-elementary.k12.us is school work whatever its body says.
 */
const SCHOOL_SENDER = /@[\w.-]*(?:school|k12|\.edu\b|academy|college|isd|gymnasium|lycee)/i;
const SPORTS_SENDER = /@[\w.-]*(?:sport|athletic|soccer|football|hockey|swim|gymnastic|tennis|league|club)/i;

/**
 * Promotional markers. A flyer selling team jerseys says "team" and "jersey"
 * and is not the family's sports admin; it is suppressed unless the message
 * carries enough real signals to stand on its own.
 */
const PROMOTIONAL = /\b(?:limited[-\s]time offer|special deal|you(?:'ve| have) won|claim your prize|promo code|shop now|\d{1,3}%\s*off|free quote|act now)\b/i;
const PROMOTIONAL_OVERRIDE_SCORE = 3;

// Sub-kinds, in the order they are tried. The first that matches wins, so the
// order encodes what a parent has to do FIRST: a practice that moved is a
// schedule change even when the same mail also says to bring shin guards.
const SUB_KIND_RULES: { kind: FrontDeskSubKind; re: RegExp }[] = [
  {
    kind: 'schedule_change',
    re: /\b(?:cancell?ed|postponed?|reschedul\w*|moved to|move to|new (?:time|date|location|venue)|time change|date change|change of (?:time|date|venue)|has been changed|changed to|rained out|rain[-\s]out|snow day|will now (?:start|begin|be|take place))\b/i,
  },
  {
    kind: 'form',
    re: /\b(?:permission slips?|consent forms?|forms?|waivers?|sign and return|signed and returned|signature|paperwork|medical form|physical form|emergency contact (?:card|form|details)|enrolment form|enrollment form|opt[-\s]out)\b/i,
  },
  {
    kind: 'fee',
    re: /\b(?:fees?|dues|invoices?|tuition|amount due|balance due|payment due|registration fee|subs)\b/i,
  },
  {
    kind: 'transport',
    re: /\b(?:pick[-\s]?ups?|drop[-\s]?offs?|carpools?|car pool|buses|busses|bus|rides?|transport(?:ation)?|shuttle|depart(?:s|ure|ing)?|coach travel|meet at the)\b/i,
  },
  {
    kind: 'gear',
    re: /\b(?:bring|cleats|jerseys?|uniforms?|water bottles?|mouth\s?guards?|shin guards?|equipment|gear|kit list|supply list|supplies|goggles|helmets?|rackets?|racquets?|swimsuit|leotard|trainers|boots)\b/i,
  },
];

/**
 * Words that mean "money is owed" but are far too common to stand alone.
 * They only make a message a `fee` when an actual amount was found with them.
 */
const FEE_WITH_AMOUNT = /\b(?:pay|payable|payment|cost|costs|charge|deposit|due|owed?|outstanding)\b/i;

// ── small pure helpers ─────────────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textOf(message: FrontDeskMessage): string {
  return [message.subject ?? '', message.body ?? ''].filter(Boolean).join('\n');
}

/** Index of the first match, or Infinity — used only to break an exact score tie. */
function firstIndex(haystack: string, patterns: RegExp[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const re of patterns) {
    const match = re.exec(haystack);
    if (match && match.index < best) best = match.index;
  }
  return best;
}

function countSignals(haystack: string, patterns: RegExp[]): { score: number; matched: RegExp[] } {
  const matched = patterns.filter((re) => re.test(haystack));
  return { score: matched.length, matched };
}

// ── amount ─────────────────────────────────────────────────────────────────

const CURRENCY_BY_SYMBOL: Record<string, 'USD' | 'EUR' | 'GBP'> = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP',
  dollar: 'USD',
  dollars: 'USD',
  euro: 'EUR',
  euros: 'EUR',
  pound: 'GBP',
  pounds: 'GBP',
};

const SIGNED_AMOUNT = /(\$|€|£|\bUSD\b|\bEUR\b|\bGBP\b)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/i;
const TRAILING_AMOUNT = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(dollars?|euros?|pounds?)\b/i;

/**
 * An amount, in minor units, ONLY when the text signs it as money. A bare
 * "2026" or "45 minutes" is a number, not a price, and treating it as one is
 * how a family gets told a school notice costs twenty euros.
 */
function extractAmount(haystack: string): { amount_cents: number; currency: 'USD' | 'EUR' | 'GBP' } | null {
  const signed = SIGNED_AMOUNT.exec(haystack);
  const trailing = TRAILING_AMOUNT.exec(haystack);
  const useSigned = signed !== null && (trailing === null || signed.index <= trailing.index);
  const match = useSigned ? signed : trailing;
  if (!match) return null;

  const symbol = useSigned ? match[1] : match[3];
  const whole = useSigned ? match[2] : match[1];
  const fraction = useSigned ? match[3] : match[2];
  const currency = CURRENCY_BY_SYMBOL[symbol.trim().toLowerCase()];
  if (!currency) return null;

  const units = Number.parseInt(whole.replace(/,/g, ''), 10);
  if (!Number.isFinite(units)) return null;
  // "9.5" is nine-fifty, not nine and five cents.
  const minor = fraction ? Number.parseInt(fraction.padEnd(2, '0'), 10) : 0;
  return { amount_cents: units * 100 + minor, currency };
}

// ── date and time ──────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH_FIRST = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i;
const DAY_FIRST = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}))?\b/i;
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

/** How far into the past a year-less date may fall before it is read as next year. */
const YEARLESS_LOOKBACK_DAYS = 180;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Resolve a month/day whose year the text did not state.
 *
 * Needs `now`, and says so by returning null without it. The alternative —
 * assuming the current year from the machine clock — is exactly the impurity
 * this module exists without: the same message would classify differently on
 * 31 December and 1 January, and a test could not pin either.
 */
function resolveYearless(month: number, day: number, nowMs: number | null): string | null {
  if (nowMs === null) return null;
  const year = new Date(nowMs).getUTCFullYear();
  for (const candidate of [year, year + 1]) {
    if (!isRealDate(candidate, month, day)) continue;
    const at = Date.UTC(candidate, month - 1, day);
    if (at >= nowMs - YEARLESS_LOOKBACK_DAYS * 86_400_000) return isoDate(candidate, month, day);
  }
  return isRealDate(year + 1, month, day) ? isoDate(year + 1, month, day) : null;
}

function fullYear(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return raw.length === 2 ? 2000 + n : n;
}

function extractDate(haystack: string, nowMs: number | null): string | null {
  const iso = ISO_DATE.exec(haystack);
  if (iso) {
    const year = Number.parseInt(iso[1], 10);
    const month = Number.parseInt(iso[2], 10);
    const day = Number.parseInt(iso[3], 10);
    return isRealDate(year, month, day) ? isoDate(year, month, day) : null;
  }

  const monthFirst = MONTH_FIRST.exec(haystack);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = Number.parseInt(monthFirst[2], 10);
    if (monthFirst[3]) {
      const year = fullYear(monthFirst[3]);
      return isRealDate(year, month, day) ? isoDate(year, month, day) : null;
    }
    return resolveYearless(month, day, nowMs);
  }

  const dayFirst = DAY_FIRST.exec(haystack);
  if (dayFirst) {
    const day = Number.parseInt(dayFirst[1], 10);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (dayFirst[3]) {
      const year = fullYear(dayFirst[3]);
      return isRealDate(year, month, day) ? isoDate(year, month, day) : null;
    }
    return resolveYearless(month, day, nowMs);
  }

  // Numeric dates are read month-first. That is a choice, not a truth: 3/4 is
  // the fourth of March here and the third of April in most of Europe, and no
  // amount of parsing settles it. It is last in the order so a spelled-out
  // month anywhere in the same message wins, and it is documented on the type.
  const numeric = NUMERIC_DATE.exec(haystack);
  if (numeric) {
    const month = Number.parseInt(numeric[1], 10);
    const day = Number.parseInt(numeric[2], 10);
    if (numeric[3]) {
      const year = fullYear(numeric[3]);
      return isRealDate(year, month, day) ? isoDate(year, month, day) : null;
    }
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? resolveYearless(month, day, nowMs) : null;
  }

  return null;
}

const MERIDIEM_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i;
const CLOCK_TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

function extractTime(haystack: string): string | null {
  const meridiem = MERIDIEM_TIME.exec(haystack);
  if (meridiem) {
    let hour = Number.parseInt(meridiem[1], 10);
    const minute = meridiem[2] ? Number.parseInt(meridiem[2], 10) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = meridiem[3].toLowerCase().startsWith('p');
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const clock = CLOCK_TIME.exec(haystack);
  if (clock) return `${clock[1].padStart(2, '0')}:${clock[2]}`;
  return null;
}

// ── the child ──────────────────────────────────────────────────────────────

type ChildCandidate = { member_id: string; name: string; weight: number; at: number };

function nameMatch(haystack: string, name: string): number {
  const trimmed = name.trim();
  if (trimmed.length < 3) return -1;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, 'iu');
  const match = re.exec(haystack);
  return match ? match.index : -1;
}

/**
 * Which child this is about.
 *
 * Three ways to know, strongest first: the child's full name in the text, a
 * roster row whose team / coach / teacher / school the text names, and the
 * child's first name alone. A first name is the weakest because families use
 * short common names and "will Max be there?" is a sentence about a dog as
 * often as a boy — it is still worth having, and it is why the weight, not the
 * mere fact of a match, decides.
 */
function pickChild(
  haystack: string,
  members: RosterMember[],
  teams: RosterTeam[],
  classes: RosterClass[],
): ChildCandidate | null {
  const byId = new Map(members.map((m) => [m.id, (m.display_name ?? '').trim()]));
  const candidates: ChildCandidate[] = [];

  for (const member of members) {
    const full = (member.display_name ?? '').trim();
    if (!full) continue;
    const fullAt = nameMatch(haystack, full);
    if (fullAt >= 0) {
      candidates.push({ member_id: member.id, name: full, weight: 3, at: fullAt });
      continue;
    }
    const first = full.split(/\s+/)[0] ?? '';
    const firstAt = first === full ? -1 : nameMatch(haystack, first);
    if (firstAt >= 0) candidates.push({ member_id: member.id, name: full, weight: 1, at: firstAt });
  }

  const rosterHints: { memberId: string | null | undefined; values: (string | null | undefined)[] }[] = [
    ...teams.map((t) => ({ memberId: t.member_id, values: [t.team_name, t.coach] })),
    ...classes.map((c) => ({ memberId: c.member_id, values: [c.teacher, c.school_name] })),
  ];
  for (const hint of rosterHints) {
    if (!hint.memberId) continue;
    const name = byId.get(hint.memberId);
    if (name === undefined || name === '') continue;
    for (const value of hint.values) {
      const at = value ? nameMatch(haystack, value) : -1;
      if (at >= 0) candidates.push({ member_id: hint.memberId, name, weight: 2, at });
    }
  }

  if (candidates.length === 0) return null;
  // Strongest evidence, then the one the message mentions first, then roster
  // order — three total tie-breaks so the answer never depends on iteration luck.
  return candidates.reduce((best, next) => {
    if (next.weight !== best.weight) return next.weight > best.weight ? next : best;
    return next.at < best.at ? next : best;
  });
}

// ── the domain ─────────────────────────────────────────────────────────────

type DomainVerdict = { domain: FrontDeskDomain | null; score: number };

function rosterStrings(teams: RosterTeam[], classes: RosterClass[]): { school: string[]; sports: string[] } {
  const sports = teams
    .flatMap((t) => [t.team_name, t.coach, t.sport])
    .filter((v): v is string => typeof v === 'string' && v.trim().length >= 3);
  const school = classes
    .flatMap((c) => [c.teacher, c.school_name])
    .filter((v): v is string => typeof v === 'string' && v.trim().length >= 3);
  return { school, sports };
}

function scoreDomains(
  haystack: string,
  from: string,
  teams: RosterTeam[],
  classes: RosterClass[],
): DomainVerdict {
  const roster = rosterStrings(teams, classes);
  const rosterSchool = roster.school.filter((v) => nameMatch(haystack, v) >= 0).length;
  const rosterSports = roster.sports.filter((v) => nameMatch(haystack, v) >= 0).length;

  const school = countSignals(haystack, SCHOOL_SIGNALS);
  const sports = countSignals(haystack, SPORTS_SIGNALS);

  // A roster row the message names is worth two keywords: the family told us
  // this coach coaches their child, which a word list never knows.
  let schoolScore = school.score + rosterSchool * 2 + (SCHOOL_SENDER.test(from) ? 2 : 0);
  let sportsScore = sports.score + rosterSports * 2 + (SPORTS_SENDER.test(from) ? 2 : 0);

  if (PROMOTIONAL.test(haystack)) {
    if (schoolScore < PROMOTIONAL_OVERRIDE_SCORE) schoolScore = 0;
    if (sportsScore < PROMOTIONAL_OVERRIDE_SCORE) sportsScore = 0;
  }

  if (schoolScore === 0 && sportsScore === 0) return { domain: null, score: 0 };
  if (schoolScore !== sportsScore) {
    return schoolScore > sportsScore
      ? { domain: 'school', score: schoolScore }
      : { domain: 'sports', score: sportsScore };
  }
  // A dead heat — "the soccer team meets at school" — goes to whichever signal
  // the message leads with, which is the one it is actually about.
  const schoolAt = firstIndex(haystack, school.matched);
  const sportsAt = firstIndex(haystack, sports.matched);
  if (schoolAt === sportsAt) return { domain: 'school', score: schoolScore };
  return schoolAt < sportsAt
    ? { domain: 'school', score: schoolScore }
    : { domain: 'sports', score: sportsScore };
}

function pickSubKind(haystack: string, hasAmount: boolean): FrontDeskSubKind | null {
  for (const rule of SUB_KIND_RULES) {
    if (rule.re.test(haystack)) return rule.kind;
  }
  // "Please settle the 25 pounds before Friday" names no fee word at all; an
  // amount plus a word that means owing is enough, and an amount alone is not.
  if (hasAmount && FEE_WITH_AMOUNT.test(haystack)) return 'fee';
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Classify one inbound message against this family's roster.
 *
 * Returns `{ domain: null, subKind: null, confidence: 0 }` for anything that is
 * not school or sports work — the honest answer for a grocery receipt, a
 * delivery notice or a sales flyer, and the reason the desk card can list what
 * it lists without a column to store the verdict in.
 */
export function classify(
  message: FrontDeskMessage,
  members: RosterMember[] = [],
  teams: RosterTeam[] = [],
  classes: RosterClass[] = [],
  options: ClassifyOptions = {},
): FrontDeskClassification {
  const haystack = textOf(message);
  const from = (message.from_addr ?? '').trim();
  if (!haystack.trim() && !from) return { domain: null, subKind: null, confidence: 0 };

  const verdict = scoreDomains(haystack, from, teams, classes);
  if (!verdict.domain) return { domain: null, subKind: null, confidence: 0 };

  const money = extractAmount(haystack);
  const subKind = pickSubKind(haystack, money !== null);

  const nowMs = options.now ? Date.parse(options.now) : Number.NaN;
  const date = extractDate(haystack, Number.isFinite(nowMs) ? nowMs : null);
  const time = extractTime(haystack);
  const child = pickChild(haystack, members, teams, classes);

  const confidence = round2(Math.min(
    0.95,
    0.35
    + Math.min(verdict.score, 3) * 0.1
    + (subKind ? 0.15 : 0)
    + (child ? 0.1 : 0)
    + (date ? 0.05 : 0)
    + (money ? 0.05 : 0),
  ));

  return {
    domain: verdict.domain,
    subKind,
    ...(child ? { child: { member_id: child.member_id, name: child.name } } : {}),
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(money ? { amount_cents: money.amount_cents, currency: money.currency } : {}),
    confidence,
  };
}

/**
 * The text-only half, for callers that have no roster in hand.
 *
 * `lib/contact-center/routing.ts` runs inside an inbound webhook that has the
 * family id and the raw message and nothing else loaded; it needs the domain
 * to file `ai_intent`, and reading the roster from a webhook to do it would
 * turn a pure classification into two database round trips per delivery.
 */
export function frontDeskDomain(text: string | null | undefined): FrontDeskDomain | null {
  return classify({ body: text ?? '' }).domain;
}

/** Every sub-kind, in the order the desk shows them. Exported so a UI cannot invent a sixth. */
export const FRONT_DESK_SUB_KINDS: readonly FrontDeskSubKind[] = [
  'form', 'fee', 'gear', 'transport', 'schedule_change',
] as const;

// ── what to propose ────────────────────────────────────────────────────────

/**
 * Gear a message asks the family to bring, taken VERBATIM from the message.
 *
 * The patterns are English because the keyword pass is; the item that reaches
 * the shopping list is the substring the school actually wrote, so a German
 * school's "Turnbeutel" is never rewritten into an English word nobody used.
 */
const GEAR_ITEMS: RegExp[] = [
  /\bcleats\b/i,
  /\bshin guards?\b/i,
  /\bmouth\s?guards?\b/i,
  /\bjerseys?\b/i,
  /\buniforms?\b/i,
  /\bwater bottles?\b/i,
  /\bgoggles\b/i,
  /\bhelmets?\b/i,
  /\bracke?ts?\b/i,
  /\bracquets?\b/i,
  /\bswimsuits?\b/i,
  /\bleotards?\b/i,
  /\btrainers\b/i,
  /\bboots\b/i,
  /\bnotebooks?\b/i,
  /\bpencils?\b/i,
  /\bglue sticks?\b/i,
  /\bbackpacks?\b/i,
  /\bcalculators?\b/i,
  /\btowels?\b/i,
];

/** The gear nouns this message names, in the order it names them, de-duplicated. */
export function gearItems(message: FrontDeskMessage): string[] {
  const haystack = textOf(message);
  const found: { text: string; at: number }[] = [];
  for (const re of GEAR_ITEMS) {
    const match = re.exec(haystack);
    if (match) found.push({ text: match[0].trim(), at: match.index });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const { text } of found) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  return items;
}

/**
 * A tool call the family can be ASKED to approve. Nothing here executes:
 * `app/(app)/dashboard/school/actions.ts` hands it to `gateAiAction`, and only
 * an `allow` reaches `runAction`.
 */
export type FrontDeskProposal = {
  /**
   * A registry tool name in its legacy flat spelling, which `getTool` resolves
   * and `approval_requests.payload` has stored for months.
   */
  name: 'create_calendar_event' | 'create_reminder' | 'add_grocery_item';
  args: Record<string, unknown>;
  /** The trust domain `gateAiAction` evaluates this against. */
  domain: 'calendar' | 'scheduling' | 'shopping';
  /** The message's own words, for the approval card's title. Never invented copy. */
  subject: string;
};

/** The hour a dated reminder fires at when the message gave a day but no time. */
const DEFAULT_REMINDER_TIME = '09:00';

const MAX_TITLE = 120;

/** The message's own headline: its subject, or the first non-empty line of its body. */
export function messageTitle(message: FrontDeskMessage): string {
  const subject = (message.subject ?? '').replace(/\s+/g, ' ').trim();
  if (subject) return subject.slice(0, MAX_TITLE);
  const firstLine = (message.body ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/**
 * Turn a classification into ONE proposal, or null when there is nothing
 * honest to propose (no domain, or a message with no words to title a row with).
 *
 * The mapping is deliberately narrow, and narrower than the audit's build line:
 * the tool registry has read-only school and sports tools, no opportunities
 * tool and no rides tool, so a fee becomes a dated reminder rather than an
 * `opportunities` row and a ride becomes a calendar event rather than a `rides`
 * row. Every target below is a tool that already exists and is already gated.
 *
 * A DATE IS NEVER INVENTED. When the message states no date the reminder is
 * filed with none; when it states a day but no hour, the hour — and only the
 * hour — falls back to `DEFAULT_REMINDER_TIME`.
 */
export function buildProposal(
  message: FrontDeskMessage,
  classification: FrontDeskClassification,
): FrontDeskProposal | null {
  if (!classification.domain) return null;
  const subject = messageTitle(message);
  if (!subject) return null;

  const assignee = classification.child?.member_id ?? null;
  const date = classification.date ?? null;
  const time = classification.time ?? null;

  const calendarEvent = (): FrontDeskProposal | null => {
    if (!date) return null;
    return {
      name: 'create_calendar_event',
      domain: 'calendar',
      subject,
      args: {
        title: subject,
        starts_at: `${date}T${time ?? '00:00'}:00`,
        all_day: time === null,
        category: classification.domain === 'sports' ? 'sports' : 'school',
        ...(assignee ? { assignee_id: assignee } : {}),
      },
    };
  };

  const reminder = (): FrontDeskProposal => ({
    name: 'create_reminder',
    domain: 'scheduling',
    subject,
    args: {
      title: subject,
      remind_at: date ? `${date}T${time ?? DEFAULT_REMINDER_TIME}:00` : null,
      kind: classification.subKind === 'fee' ? 'bill' : 'school',
      ...(assignee ? { assignee_id: assignee } : {}),
    },
  });

  switch (classification.subKind) {
    case 'schedule_change':
    case 'transport':
      return calendarEvent() ?? reminder();
    case 'gear': {
      const items = gearItems(message);
      if (items.length === 0) return reminder();
      return {
        name: 'add_grocery_item',
        domain: 'shopping',
        subject,
        args: { items: items.map((name) => ({ name })) },
      };
    }
    case 'form':
    case 'fee':
    default:
      return reminder();
  }
}
