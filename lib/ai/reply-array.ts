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

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A JSON value: an array is the answer, and anything else — an object, a string, a number — is not. */
const asAnswer = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

/**
 * The reply's top-level JSON array, or null when the reply does not hold one.
 *
 * In this order, each deciding when it applies:
 *
 * 1. The whole reply, when it IS JSON. Its value is the answer: an array as is
 *    (`[]` included — the model's "nothing there"), anything else null. A JSON
 *    string `"[]"` is a string, and a fence or a bracket inside a string value
 *    (an event described as "```[]```") is text, not structure — so nothing is
 *    looked for inside a reply that parses.
 * 2. A reply that is one fenced block and nothing else: its inside, whole, by
 *    the same rule.
 * 3. Prose around the answer: the first bracketed span of the reply that is
 *    JSON, read string-aware, so brackets and backticks inside string values
 *    never start or end it. That span decides: an array is returned, and
 *    anything else — `{"error":[]}`, `{"recipes":[…]}` — is null, because the
 *    only shape these prompts document is a bare array and a field of an object
 *    is not one. Prose in brackets that is not JSON (`{milk, eggs}`) is skipped
 *    whole, never searched inside. A span that never closes is null: a list cut
 *    off at the token limit is not a shorter list.
 *
 * What the items must look like is the caller's schema, not this function's.
 */
export function readReplyArray(text: unknown): unknown[] | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();

  const whole = parseJson(trimmed);
  if (whole.ok) return asAnswer(whole.value);

  const fenced = /^```(?:json)?[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/i.exec(trimmed);
  if (fenced) {
    const inner = parseJson(fenced[1].trim());
    if (inner.ok) return asAnswer(inner.value);
  }

  let from = 0;
  for (;;) {
    const offset = trimmed.slice(from).search(/[[{]/);
    if (offset < 0) return null;
    const open = from + offset;
    const close = closingBracket(trimmed, open);
    if (close < 0) return null;
    const span = parseJson(trimmed.slice(open, close + 1));
    if (!span.ok) {
      from = close + 1;
      continue;
    }
    return asAnswer(span.value);
  }
}
