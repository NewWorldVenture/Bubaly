/** A partial transcription cannot establish the full document's obligations. */
export function isPaperworkExtractionPartial(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const extraction = (meta as Record<string, unknown>).extraction;
  return !!extraction && typeof extraction === 'object' && !Array.isArray(extraction)
    && (extraction as Record<string, unknown>).truncated === true;
}
