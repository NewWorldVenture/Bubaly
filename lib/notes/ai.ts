// lib/notes/ai.ts — pure, testable helpers for the Notes AI Assist feature.
// No I/O here: the route handler does the LLM call and Supabase writes; these
// functions just build the prompt and parse the model's structured reply so the
// logic is unit-testable without a network or a database.

export type NotesInsights = {
  /** One or two sentence plain-language summary of the note. */
  summary: string;
  /** Concrete, actionable to-dos extracted from the note. */
  actionItems: string[];
  /** Short lowercase topic tags for grouping/search. */
  tags: string[];
};

const MAX_ACTION_ITEMS = 8;
const MAX_TAGS = 6;
const MAX_TAG_LEN = 24;

/** Clamp the raw note text so we never ship an unbounded prompt to the model. */
export function clampNoteContent(content: string, max = 6000): string {
  const trimmed = (content ?? '').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** System + user prompt for turning a free-form family note into insights. */
export function buildNotesPrompt(content: string): { system: string; user: string } {
  const system = `You are the Bubaly family Notes assistant. A family member wrote a shared note. Read it and return STRUCTURED JSON only — no markdown, no code fences, no commentary. Start with { and end with }.

Use exactly this shape:
{
  "summary": "1-2 sentence plain-language summary of what this note is about",
  "actionItems": ["specific actionable to-do", "another to-do"],
  "tags": ["lowercase-topic", "another-topic"]
}

Rules:
- summary: warm, concrete, never empty. If the note is trivial, summarize it in one short sentence.
- actionItems: only real, doable tasks implied by the note (max ${MAX_ACTION_ITEMS}). Empty array if there are none — do not invent busywork.
- tags: ${MAX_TAGS} or fewer short lowercase topic tags (e.g. "groceries", "school", "travel"). No "#".
- Be family-friendly and never include private credentials or sensitive data verbatim.`;

  const user = `Here is the family note:\n\n"""\n${clampNoteContent(content)}\n"""\n\nReturn the JSON now.`;
  return { system, user };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v): v is string => v.length > 0);
}

function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, MAX_TAG_LEN);
}

/**
 * Parse the model's reply into NotesInsights. Tolerant of code fences and
 * surrounding prose: extracts the first JSON object. Always returns a valid
 * (possibly empty) shape so callers never crash on a malformed completion.
 */
export function parseNotesResponse(raw: string): NotesInsights {
  const empty: NotesInsights = { summary: '', actionItems: [], tags: [] };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const actionItems = asStringArray(parsed.actionItems).slice(0, MAX_ACTION_ITEMS);
  const tags = Array.from(
    new Set(asStringArray(parsed.tags).map(normalizeTag).filter((t) => t.length > 0)),
  ).slice(0, MAX_TAGS);

  return { summary, actionItems, tags };
}

/**
 * Render insights as a markdown block that can be appended to a note body.
 * Pure string building so the "write back to Supabase" path is testable.
 */
export function formatInsightsForNote(insights: NotesInsights): string {
  const lines: string[] = ['', '---', '🪄 AI summary'];
  if (insights.summary) lines.push(insights.summary);
  if (insights.actionItems.length > 0) {
    lines.push('', 'Action items:');
    for (const item of insights.actionItems) lines.push(`[ ] ${item}`);
  }
  if (insights.tags.length > 0) {
    lines.push('', `Tags: ${insights.tags.map((t) => `#${t}`).join(' ')}`);
  }
  return lines.join('\n');
}
