// Context slice names, in the family's words.
//
// `lib/ai/context/intents.ts` names the thirteen slices Bubaly can assemble
// ('people', 'schedule', 'money'…). Those are identifiers: they are what the
// builder persists on `ai_request_context` and what the policy withholds by
// name. This module is the one place that turns them into something a parent
// reads, so the Trust Center's Activity tab and the "Based on" expander on an
// approval card cannot drift into two different vocabularies for the same
// disclosure.
//
// Pure and dependency-free on purpose: both callers are client components, and
// `lib/ai/context/*` is `server-only`.
//
// Each entry keeps the English beside its catalogue key — the label is what a
// reviewer reads in the diff, and it is what renders if a translation is
// missing rather than a bare key.
export type SliceLabel = { slice: string; label: string; labelKey: string };

export const SLICE_LABELS: readonly SliceLabel[] = [
  { slice: 'people', label: 'Who is in the family', labelKey: 'trustActivity.slicePeople' },
  { slice: 'schedule', label: 'The calendar', labelKey: 'trustActivity.sliceSchedule' },
  { slice: 'activities', label: 'School and teams', labelKey: 'trustActivity.sliceActivities' },
  { slice: 'food', label: 'Food and allergies', labelKey: 'trustActivity.sliceFood' },
  { slice: 'shopping', label: 'Groceries and pantry', labelKey: 'trustActivity.sliceShopping' },
  { slice: 'tasks', label: 'To-dos and chores', labelKey: 'trustActivity.sliceTasks' },
  { slice: 'money', label: 'Budgets and bills', labelKey: 'trustActivity.sliceMoney' },
  { slice: 'home', label: 'Home, vehicles and pets', labelKey: 'trustActivity.sliceHome' },
  { slice: 'vendors', label: 'Saved contractors', labelKey: 'trustActivity.sliceVendors' },
  { slice: 'travel', label: 'Trips', labelKey: 'trustActivity.sliceTravel' },
  { slice: 'documents', label: 'Document titles and expiry', labelKey: 'trustActivity.sliceDocuments' },
  { slice: 'memory', label: 'Remembered facts', labelKey: 'trustActivity.sliceMemory' },
  { slice: 'proactive', label: 'Signals and suggestions', labelKey: 'trustActivity.sliceProactive' },
];

const BY_NAME = new Map(SLICE_LABELS.map((entry) => [entry.slice, entry]));

/** The catalogue key for a slice, or null when the name is not one we ship. */
export function sliceLabelKey(slice: string): string | null {
  return BY_NAME.get(slice)?.labelKey ?? null;
}

/** The English label for a slice, falling back to the raw name. */
export function sliceLabel(slice: string): string {
  return BY_NAME.get(slice)?.label ?? slice;
}
