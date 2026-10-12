// Reserved bookkeeping stays out of editable/displayed user tags. The existing
// column is retained across ordinary edits; it is not a permissions credential.
export const AUTOPILOT_SOURCE_TAG = 'autopilot-source:';
/**
 * Whether a tag is an accepted Autopilot card's stamp (lib/services/autopilot
 * sourceTag: the prefix and a sha-256), not a tag somebody typed that happens
 * to start with the prefix ("autopilot-source:notes").
 */
export const isReminderProvenanceTag = (tag: string) => /^autopilot-source:[a-f0-9]{64}$/.test(tag);
/** Whether these tags carry the stamp an accepted Autopilot card writes (lib/services/autopilot suggestionSourceTag). */
export const hasReminderProvenance = (tags: string[] | null | undefined): boolean => (tags ?? []).some(isReminderProvenanceTag);
/** The stamps among these tags, each the tag of the card a reminder was accepted from. */
export const reminderProvenanceTags = (tags: string[] | null | undefined): string[] => (tags ?? []).filter(isReminderProvenanceTag);
export const visibleReminderTags = (tags: string[] | null | undefined): string[] => (tags ?? []).filter((tag) => !isReminderProvenanceTag(tag));
export const withReminderProvenance = (original: string[] | null | undefined, edited: string[]): string[] => [
  ...visibleReminderTags(edited), ...(original ?? []).filter(isReminderProvenanceTag),
];
