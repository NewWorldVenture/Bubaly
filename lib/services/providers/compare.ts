// Compare the quotes a family has on file for a project. Pure and
// deterministic: no database, no model, no clock it was not handed.
//
// WHAT THIS IS AND IS NOT. `project_quotes` (migration 0246) are typed in by a
// parent — the amount a contractor quoted, whether materials are included, the
// lead time, how long it is valid, and free-text notes. Bubaly has no provider
// directory and solicits no quotes, so everything below ranks ONLY what the
// family recorded and says why. It is a comparison, not a recommendation: the
// points are a stated heuristic (price first, then how soon they can start,
// then what is included, then whether anything about scope or warranty was
// written down), every rank carries the reasons it got, and a tie is explained
// rather than broken silently.
//
// The same function serves the projects module (rendered through `labelKey`)
// and the read-only AI tool `services.compareQuotes` (rendered through `text`),
// so the family and the assistant see one ranking.

export type ComparableQuote = {
  id: string;
  contractor_name: string;
  amount_cents: number;
  includes_materials: boolean;
  lead_time_days: number | null;
  valid_until: string | null;
  status: string;
  notes: string | null;
};

export type QuoteReasonCode =
  | 'lowest_price' | 'above_lowest'
  | 'shortest_lead_time' | 'lead_time' | 'no_lead_time'
  | 'includes_materials' | 'labour_only'
  | 'has_notes' | 'no_notes'
  | 'expires_soon' | 'accepted'
  | 'tie_broken_by_price' | 'tie_broken_by_lead_time' | 'tie_broken_by_name'
  | 'still_waiting' | 'expired' | 'declined' | 'no_amount';

/** One reason, in English for the assistant and as a catalogue key + params for the UI. */
export type QuoteReason = {
  code: QuoteReasonCode;
  text: string;
  labelKey: string;
  params?: Record<string, string | number>;
};

export type RankedQuote<T extends ComparableQuote = ComparableQuote> = {
  quote: T;
  rank: number;
  /** 0–100; the heuristic's points, so two ranks can be compared. */
  score: number;
  reasons: QuoteReason[];
  /** Ids of quotes this one scored identically with. */
  tiedWith: string[];
};

export type QuoteComparison<T extends ComparableQuote = ComparableQuote> = {
  ranked: RankedQuote<T>[];
  /** Quotes that cannot be ranked yet, each with the reason. */
  excluded: { quote: T; reason: QuoteReason }[];
  lowest: T | null;
  /** Each tie, as the reason that ordered it. */
  ties: QuoteReason[];
  /** One English line for the assistant's summary. */
  summary: string;
};

// The heuristic, stated once so the reasons and the score cannot disagree.
const PRICE_POINTS = 50;
const LEAD_POINTS = 25;
const MATERIALS_POINTS = 15;
const NOTES_POINTS = 10;
const EXPIRES_SOON_DAYS = 7;
const DAY_MS = 86_400_000;

const KEY = 'compareQuotes';

function reason(code: QuoteReasonCode, text: string, labelKey: string, params?: Record<string, string | number>): QuoteReason {
  return params ? { code, text, labelKey, params } : { code, text, labelKey };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS);
}

function isExpired(q: ComparableQuote, todayKey: string): boolean {
  return q.status === 'expired' || (!!q.valid_until && q.valid_until.slice(0, 10) < todayKey);
}

function hasNotes(q: ComparableQuote): boolean {
  return typeof q.notes === 'string' && q.notes.trim().length > 0;
}

function byName(a: ComparableQuote, b: ComparableQuote): number {
  return a.contractor_name.localeCompare(b.contractor_name) || a.id.localeCompare(b.id);
}

/**
 * Rank the quotes for ONE project. Pass the rows of that project only; the
 * function does not filter by project so the caller decides what "the
 * project" is. `today` is a `YYYY-MM-DD` key or a Date; defaults to now.
 */
export function compareQuotes<T extends ComparableQuote>(quotes: readonly T[], opts: { today?: string | Date } = {}): QuoteComparison<T> {
  const todayKey = opts.today instanceof Date ? dayKey(opts.today) : (opts.today ?? dayKey(new Date())).slice(0, 10);

  const excluded: { quote: T; reason: QuoteReason }[] = [];
  const live: T[] = [];
  for (const q of [...quotes].sort(byName)) {
    if (q.status === 'requested') excluded.push({ quote: q, reason: reason('still_waiting', 'Still waiting for this quote', `${KEY}.stillWaiting`) });
    else if (q.status === 'declined') excluded.push({ quote: q, reason: reason('declined', 'Declined', `${KEY}.declined`) });
    else if (isExpired(q, todayKey)) excluded.push({ quote: q, reason: reason('expired', `Expired ${q.valid_until ?? ''}`.trim(), `${KEY}.expired`, { date: q.valid_until ?? '' }) });
    else if (!(q.amount_cents > 0)) excluded.push({ quote: q, reason: reason('no_amount', 'No amount recorded', `${KEY}.noAmount`) });
    else live.push(q);
  }

  if (live.length === 0) {
    return { ranked: [], excluded, lowest: null, ties: [], summary: excluded.length ? 'No live quotes to compare yet.' : 'No quotes on file.' };
  }

  const lowestAmount = Math.min(...live.map((q) => q.amount_cents));
  const lowest = live.filter((q) => q.amount_cents === lowestAmount).sort(byName)[0];
  const knownLeads = live.map((q) => q.lead_time_days).filter((d): d is number => typeof d === 'number' && d >= 0);
  const shortestLead = knownLeads.length ? Math.min(...knownLeads) : null;

  const scored = live.map((q) => {
    const reasons: QuoteReason[] = [];
    let score = 0;

    // Price: full points for the lowest, scaled down by how far above it sits.
    const priceScore = (lowestAmount / q.amount_cents) * PRICE_POINTS;
    score += priceScore;
    if (q.amount_cents === lowestAmount) {
      reasons.push(reason('lowest_price', 'Lowest price', `${KEY}.lowestPrice`));
    } else {
      const pct = Math.round(((q.amount_cents - lowestAmount) / lowestAmount) * 100);
      reasons.push(reason('above_lowest', `${pct}% above the lowest quote`, `${KEY}.aboveLowest`, { pct }));
    }

    // Availability: how soon they can start, relative to the soonest on file.
    if (typeof q.lead_time_days === 'number' && q.lead_time_days >= 0 && shortestLead !== null) {
      score += ((shortestLead + 1) / (q.lead_time_days + 1)) * LEAD_POINTS;
      if (q.lead_time_days === shortestLead) {
        reasons.push(reason('shortest_lead_time', `Can start soonest — ${q.lead_time_days}-day lead time`, `${KEY}.shortestLeadTime`, { days: q.lead_time_days }));
      } else {
        reasons.push(reason('lead_time', `${q.lead_time_days}-day lead time`, `${KEY}.leadTime`, { days: q.lead_time_days }));
      }
    } else {
      reasons.push(reason('no_lead_time', 'No lead time given', `${KEY}.noLeadTime`));
    }

    // What is included.
    if (q.includes_materials) {
      score += MATERIALS_POINTS;
      reasons.push(reason('includes_materials', 'Materials included', `${KEY}.includesMaterials`));
    } else {
      reasons.push(reason('labour_only', 'Labour only — materials on top', `${KEY}.labourOnly`));
    }

    // Anything written down about scope or warranty.
    if (hasNotes(q)) {
      score += NOTES_POINTS;
      reasons.push(reason('has_notes', 'Scope or warranty notes on file', `${KEY}.hasNotes`));
    } else {
      reasons.push(reason('no_notes', "No notes — ask what's included and about warranty", `${KEY}.noNotes`));
    }

    if (q.status === 'accepted') reasons.push(reason('accepted', 'Already accepted', `${KEY}.accepted`));
    if (q.valid_until && daysBetween(todayKey, q.valid_until.slice(0, 10)) <= EXPIRES_SOON_DAYS) {
      reasons.push(reason('expires_soon', `Valid until ${q.valid_until.slice(0, 10)}`, `${KEY}.expiresSoon`, { date: q.valid_until.slice(0, 10) }));
    }

    return { quote: q, score: Math.round(score * 10) / 10, reasons };
  });

  // Order: score, then the tie-breaks the reasons name. A tie is a shared score.
  scored.sort((a, b) =>
    b.score - a.score
    || a.quote.amount_cents - b.quote.amount_cents
    || (a.quote.lead_time_days ?? Number.MAX_SAFE_INTEGER) - (b.quote.lead_time_days ?? Number.MAX_SAFE_INTEGER)
    || byName(a.quote, b.quote));

  const ties: QuoteReason[] = [];
  const ranked: RankedQuote<T>[] = scored.map((entry, index) => {
    const tiedWith = scored.filter((other) => other !== entry && other.score === entry.score).map((other) => other.quote.id);
    const reasons = [...entry.reasons];
    const next = scored[index + 1];
    if (next && next.score === entry.score) {
      const name = next.quote.contractor_name;
      const tie = entry.quote.amount_cents !== next.quote.amount_cents
        ? reason('tie_broken_by_price', `Tied on points with ${name}; the lower price goes first`, `${KEY}.tieBrokenByPrice`, { name })
        : (entry.quote.lead_time_days ?? null) !== (next.quote.lead_time_days ?? null)
          ? reason('tie_broken_by_lead_time', `Tied on points and price with ${name}; the shorter lead time goes first`, `${KEY}.tieBrokenByLeadTime`, { name })
          : reason('tie_broken_by_name', `Tied on every count with ${name}; listed alphabetically`, `${KEY}.tieBrokenByName`, { name });
      reasons.push(tie);
      ties.push(tie);
    }
    return { quote: entry.quote, rank: index + 1, score: entry.score, reasons, tiedWith };
  });

  const first = ranked[0];
  const why = first.reasons.filter((r) => ['lowest_price', 'shortest_lead_time', 'includes_materials', 'has_notes'].includes(r.code)).map((r) => r.text.toLowerCase());
  const summary = ranked.length === 1
    ? `${first.quote.contractor_name} is the only live quote${why.length ? ` (${why.join(', ')})` : ''}.`
    : `${first.quote.contractor_name} ranks first of ${ranked.length}${why.length ? `: ${why.join(', ')}` : ''}${ties.length ? ' — with a tie explained' : ''}.`;

  return { ranked, excluded, lowest, ties, summary };
}
