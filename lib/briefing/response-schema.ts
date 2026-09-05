import { z } from 'zod';

export const MAX_BRIEFING_RESPONSE_BYTES = 64 * 1024;
export const BRIEFING_RESPONSE_LIMITS = {
  text: 1000,
  label: 200,
  time: 40,
  icon: 32,
  listItems: 50,
  nestedItems: 20,
  categories: 10,
  age: 120,
  eventCount: 1000,
} as const;

const limits = BRIEFING_RESPONSE_LIMITS;
const text = z.string().max(limits.text);
const label = z.string().max(limits.label);
const icon = z.string().max(limits.icon);
const score = z.number().finite().min(0).max(100);
const conflict = z.object({ description: text, suggestion: text }).strict();
const reminder = z.object({
  text,
  urgency: z.enum(['high', 'medium', 'low']),
}).strict();

// Mirrors the briefing component's required, optional, and nullable fields.
// No model-controlled URL fields are part of this response contract.
export const BriefingResponseSchema = z.object({
  greeting: label,
  subtitle: label,
  familySummary: z.array(text).max(limits.listItems),
  schedule: z.array(z.object({
    time: z.string().max(limits.time),
    title: label,
    member: label,
    emoji: icon,
    color: z.enum(['blue', 'purple', 'rose', 'emerald', 'amber', 'cyan', 'indigo']),
  }).strict()).max(limits.listItems),
  conflicts: z.array(conflict).max(limits.listItems),
  kidsNeeds: z.array(z.object({
    name: label,
    age: z.number().int().min(0).max(limits.age).optional(),
    items: z.array(text).max(limits.nestedItems),
  }).strict()).max(limits.listItems),
  meals: z.array(z.object({
    meal: label,
    name: label.nullable(),
    // The component defines status as free text, not a closed enum.
    status: label,
    missing: z.array(label).max(limits.nestedItems).optional(),
  }).strict()).max(limits.listItems),
  reminders: z.array(reminder).max(limits.listItems),
  operationsScore: z.object({
    overall: score,
    categories: z.array(z.object({ label, score, icon }).strict()).max(limits.categories),
    stressLevel: z.enum(['low', 'moderate', 'high']),
    stressReason: text.nullable(),
    recommendation: text,
  }).strict(),
  completed: z.array(text).max(limits.listItems).optional(),
  outstanding: z.array(z.object({
    text,
    urgency: z.enum(['high', 'medium']),
  }).strict()).max(limits.listItems).optional(),
  tomorrowPreview: z.object({
    events: z.number().int().min(0).max(limits.eventCount),
    notes: z.array(text).max(limits.nestedItems),
  }).strict().optional(),
  weeklyHighlights: z.array(z.object({
    category: label,
    emoji: icon,
    items: z.array(text).max(limits.nestedItems),
  }).strict()).max(limits.listItems).optional(),
  weeklyConflicts: z.array(conflict).max(limits.listItems).optional(),
}).strict();

export type BriefingResponse = z.infer<typeof BriefingResponseSchema>;

/** Validate the entire bounded completion; never extract JSON from prose. */
export function parseBriefingResponse(raw: unknown): BriefingResponse | null {
  if (typeof raw !== 'string' || raw.length > MAX_BRIEFING_RESPONSE_BYTES) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_BRIEFING_RESPONSE_BYTES) return null;

  try {
    const value: unknown = JSON.parse(raw);
    const result = BriefingResponseSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    // Invalid output must not escape into the public response or its logs.
    return null;
  }
}
