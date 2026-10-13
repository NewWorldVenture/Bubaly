// lib/ai/reply-array.ts — the JSON array a "Return ONLY a JSON array" prompt
// asked for, read out of the model's reply.
//
// Fridge Chef and the flyer scan both tolerate a markdown fence or a line of
// prose around the array, and both used to take everything from the first `[`
// to the last `]`. That also picked an array out of the middle of an object:
// `{"error":[]}` read as the model's own empty list, so the screen said "No
// food spotted" / "No events found" about a reply that said nothing of the
// kind. The array has to be the reply's own value, not a field of one.
//
// Pure and dependency-free, so the routes that use it unit-test without a
// network.

/**
 * The index of the bracket that closes the `[` or `{` at `open`, or -1 when the
 * value never closes (a reply cut off at the token limit). Brackets inside JSON
 * strings do not count.
 */
function closingBracket(body: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The reply's top-level JSON array, or null when the reply does not hold one.
 *
 * Reads the first fenced block when there is one, else the whole reply, and
 * takes the first bracketed span in it that is JSON. That span is the answer:
 * an array is returned as is (`[]` included — the model's "nothing there"), and
 * anything else — `{"error":[]}`, `{"recipes":[…]}` — is null, because the
 * only shape these prompts document is a bare array, and a field of an object
 * is not one. Prose in brackets that is not JSON (`{milk, eggs}`) is skipped
 * whole, never searched inside, so an array nested in it is not picked up
 * either. A span that never closes is null: a list cut off at the token limit
 * is not a shorter list.
 *
 * What the items must look like is the caller's schema, not this function's.
 */
export function readReplyArray(text: unknown): unknown[] | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  let from = 0;
  for (;;) {
    const offset = body.slice(from).search(/[[{]/);
    if (offset < 0) return null;
    const open = from + offset;
    const close = closingBracket(body, open);
    if (close < 0) return null;
    let value: unknown;
    try {
      value = JSON.parse(body.slice(open, close + 1));
    } catch {
      from = close + 1;
      continue;
    }
    return Array.isArray(value) ? value : null;
  }
}
