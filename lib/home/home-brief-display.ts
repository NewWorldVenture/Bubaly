// Text for the current Home view only. Do not submit or persist this projection.
import { z } from 'zod';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { HomeBrief } from './home-brief';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const homeBriefDisplaySchema = z.object({
  version: z.literal(1), headline: z.enum(['sparse', 'conflicts', 'clear']),
}).strict();
export const homeStepDisplaySchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('calendar'), eventCount: count }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('meals'), dinnerTitle: z.string().nullable() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('family') }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('grocery') }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('chores') }).strict(),
]);
export type HomeBriefDisplay = z.infer<typeof homeBriefDisplaySchema>;
export type HomeStepDisplay = z.infer<typeof homeStepDisplaySchema>;
export type HomeBriefTranslator = (key: string, params?: Record<string, string | number>) => string;

export interface HomeBriefView {
  headline: string;
  steps: { label: string; detail: string }[];
}

/** Missing, unknown or inconsistent metadata retains only that item's legacy text. */
export function formatHomeBrief(brief: HomeBrief, { locale, t }: {
  locale: LocaleCode; t: HomeBriefTranslator;
}): HomeBriefView {
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(locale);
  const plural = (key: string, value: number) => t(`homeOutcome.${key}.${plurals.select(value) === 'one' ? 'one' : 'other'}`, {
    count: numbers.format(value),
  });
  let headline = brief.headline;
  const parsed = homeBriefDisplaySchema.safeParse(brief.display);
  if (parsed.success) {
    const kind = parsed.data.headline;
    if (kind === 'sparse' && brief.isSparse) headline = t('homeOutcome.headlineSparse');
    else if (!brief.isSparse && count.safeParse(brief.weekCount).success && count.safeParse(brief.conflictCount).success) {
      if (kind === 'conflicts' && brief.conflictCount > 0) headline = t('homeOutcome.headlineConflicts', {
        events: plural('events', brief.weekCount), clashes: plural('clashes', brief.conflictCount),
      });
      // Aggregate setup counts do not establish whether anything is urgent.
      // The legacy headline stays canonical; the view makes only the supported count claim.
      else if (kind === 'clear' && brief.conflictCount === 0) headline = t('homeOutcome.headlineClear', {
        events: plural('events', brief.weekCount),
      });
    }
  }

  const steps = brief.steps.map((step) => {
    const fallback = { label: step.label, detail: step.detail };
    const result = homeStepDisplaySchema.safeParse(step.display);
    if (!result.success || result.data.kind !== step.id) return fallback;
    const display = result.data;
    let detail: string;
    if (display.kind === 'calendar') {
      if (display.eventCount !== brief.weekCount || (display.eventCount > 0) !== step.done) return fallback;
      detail = display.eventCount > 0
        ? plural('calendarEvents', display.eventCount) : t('homeOutcome.calendarEmpty');
    } else if (display.kind === 'meals') {
      if (step.done || display.dinnerTitle !== (brief.dinnerIdeas[0]?.title ?? null)) return fallback;
      detail = display.dinnerTitle !== null
        ? t('homeOutcome.mealsStart', { title: display.dinnerTitle }) : t('homeOutcome.mealsEmpty');
    } else {
      detail = t(`homeOutcome.${display.kind}${step.done ? 'Done' : 'Empty'}`);
    }
    return { label: t(display.kind === 'family' ? 'onboardingCopy.inviteYourFamily' : `homeOutcome.${display.kind}Label`), detail };
  });
  return { headline, steps };
}
