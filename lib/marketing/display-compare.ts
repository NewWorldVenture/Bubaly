// lib/marketing/display-compare.ts — what a family has to BUY or DO to put a
// shared screen in the kitchen, either way.
//
// The rules this file is written under, because a comparison page is the
// easiest place in a product to start lying:
//
//   • no competitor is named and no competitor's price appears here. A price we
//     do not control goes stale, and quoting one turns a compatibility note
//     into a claim about somebody else's business;
//   • no superlatives. Nothing here is "the best", "the only" or "unbeatable";
//     the rows state what a family needs, and the reader decides;
//   • the other column is "a dedicated family display" — a category, not a
//     brand — and the closing note says plainly that it is a different product
//     with tradeoffs of its own (it arrives ready to hang; this does not).
//
// Pure data and pure functions: no I/O, no React. The page renders `labelKey`s.

/** What a line item costs a family in effort, not money. */
export const NEED_KINDS = ['already-have', 'optional', 'buy'] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

export type DisplayNeed = {
  id: string;
  labelKey: string;
  kind: NeedKind;
};

/** Running the display on the tablet the family already owns. */
export const BUBALY_NEEDS: readonly DisplayNeed[] = [
  { id: 'tablet', labelKey: 'displayCompare.bubalyTablet', kind: 'already-have' },
  { id: 'plan', labelKey: 'displayCompare.bubalyPlan', kind: 'already-have' },
  { id: 'stand', labelKey: 'displayCompare.bubalyStand', kind: 'optional' },
  { id: 'outlet', labelKey: 'displayCompare.bubalyOutlet', kind: 'already-have' },
  { id: 'setup', labelKey: 'displayCompare.bubalySetup', kind: 'already-have' },
];

/** Buying a device whose only job is to be a family display. */
export const DEDICATED_NEEDS: readonly DisplayNeed[] = [
  { id: 'device', labelKey: 'displayCompare.dedicatedDevice', kind: 'buy' },
  { id: 'subscription', labelKey: 'displayCompare.dedicatedSubscription', kind: 'buy' },
  { id: 'mount', labelKey: 'displayCompare.dedicatedMount', kind: 'optional' },
  { id: 'outlet', labelKey: 'displayCompare.dedicatedOutlet', kind: 'already-have' },
  { id: 'setup', labelKey: 'displayCompare.dedicatedSetup', kind: 'already-have' },
];

export type CompareRow = {
  id: string;
  aspectKey: string;
  bubalyKey: string;
  dedicatedKey: string;
};

/** Side by side, on the things that actually differ. */
export const DISPLAY_COMPARE_ROWS: readonly CompareRow[] = [
  {
    id: 'hardware',
    aspectKey: 'displayCompare.rowHardware',
    bubalyKey: 'displayCompare.rowHardwareBubaly',
    dedicatedKey: 'displayCompare.rowHardwareDedicated',
  },
  {
    id: 'where',
    aspectKey: 'displayCompare.rowWhere',
    bubalyKey: 'displayCompare.rowWhereBubaly',
    dedicatedKey: 'displayCompare.rowWhereDedicated',
  },
  {
    id: 'breaks',
    aspectKey: 'displayCompare.rowBreaks',
    bubalyKey: 'displayCompare.rowBreaksBubaly',
    dedicatedKey: 'displayCompare.rowBreaksDedicated',
  },
  {
    id: 'data',
    aspectKey: 'displayCompare.rowData',
    bubalyKey: 'displayCompare.rowDataBubaly',
    dedicatedKey: 'displayCompare.rowDataDedicated',
  },
  {
    id: 'screens',
    aspectKey: 'displayCompare.rowScreens',
    bubalyKey: 'displayCompare.rowScreensBubaly',
    dedicatedKey: 'displayCompare.rowScreensDedicated',
  },
];

/** The line that stops the table from reading as a verdict. */
export const COMPARE_FAIRNESS_KEY = 'displayCompare.fairness';

/** The items on a list a family has to go out and buy. Pure. */
export function needsToBuy(needs: readonly DisplayNeed[]): DisplayNeed[] {
  return needs.filter((need) => need.kind === 'buy');
}

/** Every catalogue key this module asks a page to render. Used by the i18n test. */
export function compareCopyKeys(): string[] {
  return [
    COMPARE_FAIRNESS_KEY,
    ...BUBALY_NEEDS.map((need) => need.labelKey),
    ...DEDICATED_NEEDS.map((need) => need.labelKey),
    ...DISPLAY_COMPARE_ROWS.flatMap((row) => [row.aspectKey, row.bubalyKey, row.dedicatedKey]),
  ];
}
