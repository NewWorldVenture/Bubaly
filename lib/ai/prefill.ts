// lib/ai/prefill.ts — pure helper for the assistant's "?q=" deep link, so a
// capture routed to the AI Assistant arrives as a real question instead of an
// empty box the user has to retype into.

/**
 * Extract a prefill question from a URL query string. Returns the trimmed `q`
 * value (capped to `max` chars), or null when absent/blank. Accepts the search
 * string with or without a leading "?".
 */
export function parsePrefillQuery(search: string, max = 1000): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const q = params.get('q');
  if (!q) return null;
  const trimmed = q.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Build an assistant deep link that `parsePrefillQuery` will read back, used by
 * "ask anywhere" entry points (e.g. the home Ask bar). Returns just the base
 * path when the question is blank.
 */
export function buildAssistantUrl(question: string, base = '/dashboard/assistant'): string {
  const q = question.trim();
  return q ? `${base}?q=${encodeURIComponent(q)}` : base;
}
