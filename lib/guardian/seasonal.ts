// lib/guardian/seasonal.ts — Seasonal Intelligence for AI Call Guardian™.
// Scammers run seasonal playbooks: IRS/tax scams peak Jan–Apr, charity & gift-card
// scams peak Nov–Dec, Medicare scams during open enrollment, etc. This module
// boosts scam suspicion for the scam types that are "in season" so the pipeline
// can deflect them more aggressively at the right time of year.
//
// Pure + deterministic (date in → boosts out). No AI, no I/O.

import type { ScamType } from './scam';

export type Season =
  | 'tax_season'            // Jan 1 – Apr 18
  | 'medicare_enrollment'   // Oct 15 – Dec 7
  | 'holiday_giving'        // Nov 1 – Dec 31
  | 'back_to_school'        // Aug 1 – Sep 15
  | 'storm_recovery'        // Jun 1 – Nov 30 (hurricane/utility/charity)
  | 'none';

export type SeasonalContext = {
  season: Season;
  label: string;
  /** Scam types that are elevated this time of year. */
  elevatedScamTypes: ScamType[];
  /** Confidence boost (0-40) added to a matching scam type's score. */
  boost: number;
  /** Short note shown in explainable-AI reasoning. */
  note: string;
};

const NONE: SeasonalContext = {
  season: 'none',
  label: 'No active scam season',
  elevatedScamTypes: [],
  boost: 0,
  note: '',
};

/** Day-of-year helper (1-366), timezone-naive on the provided Date. */
function monthDay(d: Date): { month: number; day: number } {
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Is (month,day) within [startM/startD .. endM/endD] inclusive (no year-wrap)? */
function inRange(m: number, day: number, sM: number, sD: number, eM: number, eD: number): boolean {
  const v = m * 100 + day;
  return v >= sM * 100 + sD && v <= eM * 100 + eD;
}

/**
 * Determine the active scam "season" for a given date.
 * The first matching window wins (windows are ordered by specificity).
 */
export function getSeasonalContext(now: Date = new Date()): SeasonalContext {
  const { month, day } = monthDay(now);

  // Tax season — Jan 1 through tax day (~Apr 18)
  if (inRange(month, day, 1, 1, 4, 18)) {
    return {
      season: 'tax_season',
      label: 'Tax season',
      elevatedScamTypes: ['irs_scam', 'social_security_scam', 'phishing'],
      boost: 25,
      note: "It's tax season — IRS, refund, and Social Security scams spike now.",
    };
  }

  // Medicare open enrollment — Oct 15 through Dec 7
  if (inRange(month, day, 10, 15, 12, 7)) {
    return {
      season: 'medicare_enrollment',
      label: 'Medicare open enrollment',
      elevatedScamTypes: ['medicare_scam', 'social_security_scam', 'phishing'],
      boost: 25,
      note: "Medicare open enrollment is on — fake 'plan' and benefits calls spike now.",
    };
  }

  // Holiday giving — Nov 1 through Dec 31 (gift-card, charity, prize, package scams)
  if (inRange(month, day, 11, 1, 12, 31)) {
    return {
      season: 'holiday_giving',
      label: 'Holiday season',
      elevatedScamTypes: ['charity_scam', 'prize_scam', 'bank_scam', 'phishing'],
      boost: 20,
      note: 'Holiday season — gift-card, fake-charity, and prize scams spike now.',
    };
  }

  // Back to school — Aug 1 through Sep 15 (student loan / grant scams)
  if (inRange(month, day, 8, 1, 9, 15)) {
    return {
      season: 'back_to_school',
      label: 'Back-to-school',
      elevatedScamTypes: ['phishing', 'prize_scam'],
      boost: 15,
      note: 'Back-to-school window — student-loan and grant scams pick up.',
    };
  }

  // Storm / disaster recovery — Jun 1 through Nov 30 (utility + charity + warranty)
  if (inRange(month, day, 6, 1, 11, 30)) {
    return {
      season: 'storm_recovery',
      label: 'Storm-season',
      elevatedScamTypes: ['utility_scam', 'charity_scam'],
      boost: 15,
      note: 'Storm season — fake utility shut-off and disaster-charity scams rise.',
    };
  }

  return NONE;
}

/**
 * Given a detected scam type (or null) and confidence, apply any in-season boost.
 * Returns the (possibly boosted) confidence plus the seasonal note when it applied.
 */
export function applySeasonalBoost(
  scamType: ScamType | null,
  confidence: number,
  now: Date = new Date(),
): { confidence: number; boosted: boolean; note: string } {
  if (!scamType) return { confidence, boosted: false, note: '' };
  const ctx = getSeasonalContext(now);
  if (ctx.boost > 0 && ctx.elevatedScamTypes.includes(scamType)) {
    return {
      confidence: Math.min(confidence + ctx.boost, 100),
      boosted: true,
      note: ctx.note,
    };
  }
  return { confidence, boosted: false, note: '' };
}
