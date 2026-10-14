// lib/operating-index/audience.ts — which of the operating index's moves and
// the orchestrator's items are the household's money or paperwork, decided by
// where each comes from and never by the words of one the family's calendar or
// its people wrote. Household money is a parent's or an adult's
// (lib/finance/household-money.ts readsHouseholdMoney, the held 0514).
//
// "2 accounts are below zero" (the wallet) and "1 upcoming bill not covered"
// (bills) are counts of the household's money; "“Bill's recital” overlaps
// “Swim practice”", "Bill is carrying the most this week" and "“Insurance
// agent visit” — no location" are a child's to read too. For a reader who does
// not read the household's money these are left out:
//
//   - an operating index move by what it IS (managersMove): its financial
//     dimension, or the household's paperwork (renew-docs; documents are a
//     manager-only area, `SLICE_ACCESS`);
//   - any item that links to one of the household's money pages
//     (isHouseholdMoneyRoute);
//   - and, by the manager-only words (managerOnlyText), only an item whose
//     words an Autopilot card or an approval request wrote (wordedByItsSource),
//     which can be about anything, money included.
//
// The reasoning report (lib/reasoning/engine-server.ts), the operating index a
// 'member' load returns (lib/operating-index/server.ts, which the Operating
// Index page, the briefing and the Command Center render) and the calm inbox
// all apply this one rule.
import { managerOnlyText } from '@/lib/ai/context/manager-only';
import { isHouseholdMoneyRoute } from '@/lib/finance/household-money';
import type { OrchestratorItem } from './orchestrator';
import type { OperatingIndex } from './score';

/** An operating index move as far as this rule reads it: what it is, and where it links. */
export type IndexMoveSource = { id?: string | null; dimension?: string | null; href?: string | null };

/** The operating index moves about the household's paperwork, beside its financial dimension. */
const MANAGERS_PAPERWORK_MOVES: ReadonlySet<string> = new Set(['renew-docs']);

/** True for a move that is the household's money or paperwork, by what it is. */
export function managersMove(move: IndexMoveSource): boolean {
  return move.dimension === 'financial' || MANAGERS_PAPERWORK_MOVES.has(move.id ?? '') || isHouseholdMoneyRoute(move.href);
}

/**
 * The orchestrator's sources whose item text is another writer's free text:
 * an Autopilot card's action label or title, and an approval request's title
 * (lib/operating-index/server.ts). Every other item it builds is worded from
 * the calendar, a member's name or a count.
 */
const WORDED_BY_ITS_SOURCE: readonly string[] = ['/dashboard/autopilot', '/dashboard/trust'];

/** True for an item an Autopilot card or an approval request worded, by where it links. */
export function wordedByItsSource(href: string | null | undefined): boolean {
  const path = href?.split(/[?#]/)[0];
  return !!path && WORDED_BY_ITS_SOURCE.includes(path);
}

/** True for an orchestrator item that is the household's money, by where it comes from. */
export function managersItem(item: Pick<OrchestratorItem, 'label' | 'href'>): boolean {
  return isHouseholdMoneyRoute(item.href) || (wordedByItsSource(item.href) && managerOnlyText(item.label));
}

/**
 * The index as a reader who does not read the household's money is shown it:
 * without the household's money and paperwork moves, and with the financial
 * dimension's summary ("0/1 upcoming bills covered · 1 account below zero")
 * left out (`withheld`). Its scores are as computed.
 */
export function indexForMember(index: OperatingIndex): OperatingIndex {
  return {
    ...index,
    suggestions: index.suggestions.filter((s) => !managersMove(s)),
    dimensions: index.dimensions.map((d) => (d.id === 'financial' ? { ...d, summary: '', withheld: true } : d)),
  };
}
