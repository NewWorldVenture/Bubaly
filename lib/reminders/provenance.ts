// Reserved bookkeeping stays out of editable/displayed user tags. The existing
// column is retained across ordinary edits; it is not a permissions credential.
export const AUTOPILOT_SOURCE_TAG = 'autopilot-source:';
/**
 * Whether a tag is an accepted Autopilot card's stamp (lib/services/autopilot
 * sourceTag: the prefix and a sha-256), not a tag somebody typed that happens
 * to start with the prefix ("autopilot-source:notes").
 */
export const isReminderProvenanceTag = (tag: string) => /^autopilot-source:[a-f0-9]{64}$/.test(tag);
export const visibleReminderTags = (tags: string[] | null | undefined): string[] => (tags ?? []).filter((tag) => !isReminderProvenanceTag(tag));
export const withReminderProvenance = (original: string[] | null | undefined, edited: string[]): string[] => [
  ...visibleReminderTags(edited), ...(original ?? []).filter(isReminderProvenanceTag),
];
