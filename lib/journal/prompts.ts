// lib/journal/prompts.ts — Personal Journal reflection prompts.
// A deterministic daily rotation of evergreen prompts (works with zero AI), plus
// helpers for the AI-personalized prompt route. Pure + testable.

export const REFLECTION_PROMPTS: string[] = [
  'What was the best part of your day, and why?',
  'What is one thing you are grateful for right now?',
  'What challenged you today, and what did you learn from it?',
  'Who made a difference in your day?',
  'What is something you are looking forward to?',
  'How did you take care of yourself today?',
  'What is one small win you can celebrate?',
  'What would make tomorrow feel successful?',
  'What is on your mind that you want to let go of?',
  'When did you feel most like yourself today?',
  'What is a moment with your family you want to remember?',
  'What is one thing you would do differently?',
  'What gave you energy today, and what drained it?',
  'What are you proud of this week?',
];

/** Day-of-year so the "prompt of the day" is stable across a single day. */
export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}

/** A stable evergreen prompt for the given date (no AI needed). */
export function promptOfTheDay(date = new Date()): string {
  return REFLECTION_PROMPTS[dayOfYear(date) % REFLECTION_PROMPTS.length];
}

/** Build the AI prompt that turns recent entries into one fresh, personal question. */
export function buildJournalPrompt(recent: { mood: string | null; snippet: string }[]): { system: string; user: string } {
  const system = `You are a warm, thoughtful journaling companion. Given a person's recent journal snippets, write ONE short reflective question (max 20 words) that invites them to write today. Return ONLY the question text — no quotes, no preamble, no markdown.

Rules:
- Gentle and open-ended, never clinical or prescriptive.
- Build on themes you notice, but don't repeat their exact words back.
- If there's nothing to go on, ask a warm everyday reflection question.`;

  const lines = recent.slice(0, 5).map((r, i) => `${i + 1}. (${r.mood ?? 'mood n/a'}) ${r.snippet}`);
  const user = `Recent entries:\n${lines.join('\n') || '(no entries yet)'}\n\nWrite today's single reflective question.`;
  return { system, user };
}

/** Sanitize the model's reply into a single clean question line. */
export function parseJournalPrompt(raw: string): string {
  const line = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const cleaned = line.replace(/^["'`]+|["'`]+$/g, '').replace(/^\d+[.)]\s*/, '').trim();
  return cleaned;
}
