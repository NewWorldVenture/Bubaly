// Presentation only: canonical brief strings and summaries remain unchanged.
import { z } from 'zod';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { FirstBrief } from './first-brief';

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const instant = z.string().datetime({ offset: true });
const timezone = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
});
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const headlineSchema = z.enum(['empty', 'conflicts', 'clear']);
const contextSchema = z.object({
  version: z.literal(1), timezone, dayKey,
  headline: z.unknown().optional(),
}).strict();
export const firstBriefDisplaySchema = contextSchema.extend({ headline: headlineSchema });
export const briefConflictDisplaySchema = z.object({
  dayKey, overlapStart: instant, overlapEnd: instant,
}).strict().refine((value) => Date.parse(value.overlapEnd) > Date.parse(value.overlapStart));
export const briefActionDisplaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conflict'), conflictIndex: index }).strict(),
  z.object({ kind: z.literal('location'), title: z.string(), dayKey }).strict(),
  z.object({ kind: z.literal('prep'), timelineIndex: index }).strict(),
]);
export const briefOpportunityDisplaySchema = z.object({
  kind: z.enum(['recurring', 'conflicts', 'week']), count,
}).strict();

export type FirstBriefDisplay = z.infer<typeof firstBriefDisplaySchema>;
export type BriefConflictDisplay = z.infer<typeof briefConflictDisplaySchema>;
export type BriefActionDisplay = z.infer<typeof briefActionDisplaySchema>;
export type BriefOpportunityDisplay = z.infer<typeof briefOpportunityDisplaySchema>;

/** Only display text, in canonical array order. Never submit or persist this view. */
export interface FirstBriefView {
  headline: string;
  timeline: { timeLabel: string }[];
  conflicts: { dayLabel: string; overlapLabel: string }[];
  actions: { label: string; detail: string }[];
  opportunities: { label: string; detail: string }[];
}

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** Missing/invalid metadata falls back to the affected canonical text. No English parsing. */
export function formatFirstBrief(brief: FirstBrief, { locale, t }: { locale: LocaleCode; t: Translator }): FirstBriefView {
  const view: FirstBriefView = {
    headline: brief.headline,
    timeline: brief.timeline.map(({ timeLabel }) => ({ timeLabel })),
    conflicts: brief.conflicts.map(({ dayLabel, overlapLabel }) => ({ dayLabel, overlapLabel })),
    actions: brief.actions.map(({ label, detail }) => ({ label, detail })),
    opportunities: brief.opportunities.map(({ label, detail }) => ({ label, detail })),
  };
  const metadata = contextSchema.safeParse(brief.display);
  if (!metadata.success) return view;
  const display = metadata.data;
  const time = new Intl.DateTimeFormat(locale, { timeZone: display.timezone, hour: 'numeric', minute: '2-digit' });
  const weekday = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long' });
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(locale);
  const plural = (key: string, value: number) => t(`firstBriefDisplay.${key}.${plurals.select(value) === 'one' ? 'one' : 'other'}`, { count: numbers.format(value) });
  const tomorrow = new Date(Date.parse(`${display.dayKey}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const day = (value: string) => value === display.dayKey ? t('firstBriefDisplay.today')
    : value === tomorrow ? t('firstBriefDisplay.tomorrow') : weekday.format(new Date(`${value}T12:00:00Z`));
  const at = (value: string) => time.format(new Date(value));

  const headline = headlineSchema.safeParse(display.headline);
  if (headline.success) view.headline = headline.data === 'empty' ? t('firstBriefDisplay.headlineEmpty')
    : t(headline.data === 'conflicts' ? 'firstBriefDisplay.headlineConflicts' : 'firstBriefDisplay.headlineClear', {
      weekday: weekday.format(new Date(`${display.dayKey}T12:00:00Z`)),
      events: plural('events', brief.todayCount), conflicts: plural('clashes', brief.conflicts.length),
    });
  view.timeline = brief.timeline.map((item) => ({
    timeLabel: item.allDay ? t('firstBriefDisplay.allDay')
      : Number.isFinite(Date.parse(item.start)) ? at(item.start) : item.timeLabel,
  }));
  const conflicts = brief.conflicts.map((item) => briefConflictDisplaySchema.safeParse(item.display));
  view.conflicts = brief.conflicts.map((item, i) => {
    const parsed = conflicts[i];
    return parsed.success ? {
      dayLabel: day(parsed.data.dayKey),
      overlapLabel: `${at(parsed.data.overlapStart)}–${at(parsed.data.overlapEnd)}`,
    } : { dayLabel: item.dayLabel, overlapLabel: item.overlapLabel };
  });
  view.actions = brief.actions.map((item) => {
    const fallback = { label: item.label, detail: item.detail };
    const parsed = briefActionDisplaySchema.safeParse(item.display);
    if (!parsed.success || parsed.data.kind !== item.kind) return fallback;
    const action = parsed.data;
    if (action.kind === 'conflict') {
      const source = brief.conflicts[action.conflictIndex];
      if (!source || !conflicts[action.conflictIndex]?.success) return fallback;
      const conflict = view.conflicts[action.conflictIndex];
      return {
        label: t('firstBriefDisplay.resolveClash', { day: conflict.dayLabel }),
        detail: t('firstBriefDisplay.resolveClashDetail', { first: source.aTitle, second: source.bTitle, time: conflict.overlapLabel }),
      };
    }
    if (action.kind === 'location') return {
      label: t('firstBriefDisplay.addLocation'),
      detail: t('firstBriefDisplay.addLocationDetail', { title: action.title, day: day(action.dayKey) }),
    };
    const source = brief.timeline[action.timelineIndex];
    if (!source || (!source.allDay && !Number.isFinite(Date.parse(source.start)))) return fallback;
    return {
      label: t('firstBriefDisplay.prepareToday'),
      detail: t(source.allDay ? 'firstBriefDisplay.prepareAllDay' : 'firstBriefDisplay.prepareTimed', {
        title: source.title, time: view.timeline[action.timelineIndex].timeLabel,
      }),
    };
  });
  view.opportunities = brief.opportunities.map((item) => {
    const parsed = briefOpportunityDisplaySchema.safeParse(item.display);
    if (!parsed.success || parsed.data.kind !== item.id) return { label: item.label, detail: item.detail };
    const opportunity = parsed.data;
    if (opportunity.kind === 'week') return {
      label: t('firstBriefDisplay.weekOrganized'), detail: plural('weekDetail', opportunity.count),
    };
    return opportunity.kind === 'recurring' ? {
      label: plural('recurring', opportunity.count), detail: t('firstBriefDisplay.recurringDetail'),
    } : { label: plural('conflictsCaught', opportunity.count), detail: t('firstBriefDisplay.conflictsCaughtDetail') };
  });
  return view;
}
