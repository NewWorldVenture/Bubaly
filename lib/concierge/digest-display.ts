import { z } from 'zod';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { ConciergeDigest, ConciergeItem, ConciergeItemDisplay } from './digest';
import { canonicalConciergeText } from './digest';

type Translator = (key: string, params?: Record<string, string | number>) => string;
const base = { version: z.literal(1), name: z.string(), dayOffset: z.number().int().safe() };
const displaySchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('bill'), amount: z.number().finite().nullable() }).strict(),
  z.object({ ...base, kind: z.literal('medication'), member: z.string().nullable(), timeOfDay: z.string().nullable() }).strict(),
  z.object({ ...base, kind: z.literal('maintenance') }).strict(),
  z.object({ ...base, kind: z.literal('pantry') }).strict(),
  z.object({ ...base, kind: z.literal('warranty') }).strict(),
  z.object({ ...base, kind: z.literal('trip'), phase: z.enum(['ongoing', 'departure']), destination: z.string().nullable() }).strict(),
]);

function displayFor(item: ConciergeItem): ConciergeItemDisplay | null {
  const parsed = displaySchema.safeParse(item.display);
  if (!parsed.success) return null;
  const facts = parsed.data;
  if (facts.kind !== item.domain || facts.dayOffset !== item.dayOffset) return null;
  if (item.urgency !== (item.dayOffset < 0 ? 'overdue' : item.dayOffset === 0 ? 'today' : 'soon')) return null;
  const source = canonicalConciergeText(facts);
  if (source.title !== item.title || source.detail !== item.detail || source.dueLabel !== item.dueLabel || source.member !== item.member) return null;
  if ((facts.kind === 'medication' || (facts.kind === 'trip' && facts.phase === 'ongoing'))
    && (item.dayOffset !== 0 || item.urgency !== 'today')) return null;
  return facts;
}

/** A request-local view only. Never changes the canonical digest or returns metadata. */
export function formatConciergeDigest(digest: ConciergeDigest, locale: LocaleCode, t: Translator): ConciergeDigest {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  const items = digest.items.map((item): ConciergeItem => {
    const facts = displayFor(item);
    const { display: _display, ...legacy } = item;
    if (!facts) return legacy;
    const when = relative.format(item.dayOffset, 'day');
    let title = item.title;
    let detail: string;
    let dueLabel = when;
    switch (facts.kind) {
      case 'bill': detail = facts.amount === null ? t('conciergeDisplay.due', { when }) : t('conciergeDisplay.amountDue', { amount: usd.format(facts.amount), when }); break;
      case 'medication': detail = [facts.member, facts.timeOfDay].filter(Boolean).join(' · ') || t('conciergeDisplay.scheduledToday'); break;
      case 'maintenance': detail = t('conciergeDisplay.due', { when }); break;
      case 'warranty': title = t('conciergeDisplay.warrantyTitle', { name: facts.name });
        detail = t(item.dayOffset < 0 ? 'conciergeDisplay.expired' : 'conciergeDisplay.expires', { when }); break;
      case 'pantry': detail = t(item.dayOffset < 0 ? 'conciergeDisplay.expired' : 'conciergeDisplay.expires', { when }); break;
      case 'trip':
        detail = facts.phase === 'ongoing' ? t('conciergeDisplay.inProgress') : t('conciergeDisplay.departs', { when });
        if (facts.phase === 'ongoing') dueLabel = detail;
        if (facts.destination) detail = t('conciergeDisplay.destination', { detail, destination: facts.destination });
        break;
    }
    return { ...legacy, title, detail, dueLabel };
  });
  const parts: string[] = [];
  if (digest.counts.overdue) parts.push(t('conciergeDisplay.overdueCount', { count: digest.counts.overdue }));
  if (digest.counts.today) parts.push(t('conciergeDisplay.todayCount', { count: digest.counts.today }));
  if (digest.counts.soon) parts.push(t('conciergeDisplay.soonCount', { count: digest.counts.soon }));
  const headline = parts.length ? t('conciergeDisplay.headline', { parts: parts.join(', ') }) : t('conciergeDisplay.empty');
  return { items, counts: { ...digest.counts }, byDomain: digest.byDomain.map(entry => ({ ...entry })), headline };
}
