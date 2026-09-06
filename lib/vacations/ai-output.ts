import { z } from 'zod';
import type { VacBudgetCategory, VacDayPart, VacItemKind } from '@/lib/database.types';

export const VACATION_AI_OUTPUT_LIMITS = {
  text: 65_536,
  activities: 30,
  itinerary: 60,
  budget: 9,
  name: 200,
  category: 100,
  location: 500,
  // A conservative signed 32-bit cents ceiling, also safely representable in JS.
  moneyCents: 2_147_483_647,
} as const;

const title = z.string().max(VACATION_AI_OUTPUT_LIMITS.name).trim().min(1);
const dollars = z.number().finite().nonnegative()
  .max(VACATION_AI_OUTPUT_LIMITS.moneyCents / 100)
  .refine((value) => Number.isSafeInteger(Math.round(value * 100)));

const planSchema = z.object({
  activities: z.array(z.object({
    name: title,
    category: z.string().max(VACATION_AI_OUTPUT_LIMITS.category).nullish(),
    location: z.string().max(VACATION_AI_OUTPUT_LIMITS.location).nullish(),
    family_friendly: z.boolean().nullish(),
    cost: dollars.nullish(),
  }).strict()).max(VACATION_AI_OUTPUT_LIMITS.activities).default([]),
  itinerary: z.array(z.object({
    day: z.number().int().min(1).max(VACATION_AI_OUTPUT_LIMITS.itinerary),
    day_part: z.enum(['morning', 'afternoon', 'evening', 'all_day'] satisfies [VacDayPart, ...VacDayPart[]]).default('morning'),
    kind: z.enum(['activity', 'meal', 'travel', 'reservation', 'free_time', 'note', 'reminder'] satisfies [VacItemKind, ...VacItemKind[]]).default('activity'),
    title,
  }).strict()).max(VACATION_AI_OUTPUT_LIMITS.itinerary).default([]),
  budget: z.array(z.object({
    category: z.enum(['flights', 'lodging', 'transportation', 'activities', 'food', 'shopping', 'insurance', 'fees', 'misc'] satisfies [VacBudgetCategory, ...VacBudgetCategory[]]),
    planned: dollars,
  }).strict()).max(VACATION_AI_OUTPUT_LIMITS.budget).default([]),
}).strict();

export type VacationAIPlan = z.infer<typeof planSchema>;

/** Validate the entire response before any builder write, not just a JSON substring. */
export function parseVacationAIOutput(text: unknown, tripDayCount: number): VacationAIPlan | null {
  if (typeof text !== 'string' || text.length > VACATION_AI_OUTPUT_LIMITS.text) return null;
  if (!Number.isInteger(tripDayCount) || tripDayCount < 0 || tripDayCount > VACATION_AI_OUTPUT_LIMITS.itinerary) return null;

  // Tolerate a single markdown fence, but never extract an object from an array,
  // prose, or another wrapper and silently treat it as the complete plan.
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
    const result = planSchema.safeParse(value);
    if (!result.success || result.data.itinerary.some((item) => item.day > tripDayCount)) return null;
    return result.data;
  } catch {
    return null;
  }
}
