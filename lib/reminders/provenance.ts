// Reserved bookkeeping stays out of editable/displayed user tags. The existing
// column is retained across ordinary edits; it is not a permissions credential.
export const AUTOPILOT_SOURCE_TAG = 'autopilot-source:';
const isProvenance = (tag: string) => /^autopilot-source:[a-f0-9]{64}$/.test(tag);
/** Whether these tags carry the stamp an accepted Autopilot card writes (lib/services/autopilot suggestionSourceTag). */
export const hasReminderProvenance = (tags: string[] | null | undefined): boolean => (tags ?? []).some(isProvenance);
/** The stamps among these tags, each the tag of the card a reminder was accepted from. */
export const reminderProvenanceTags = (tags: string[] | null | undefined): string[] => (tags ?? []).filter(isProvenance);
export const visibleReminderTags = (tags: string[] | null | undefined): string[] => (tags ?? []).filter((tag) => !isProvenance(tag));
export const withReminderProvenance = (original: string[] | null | undefined, edited: string[]): string[] => [
  ...visibleReminderTags(edited), ...(original ?? []).filter(isProvenance),
];
