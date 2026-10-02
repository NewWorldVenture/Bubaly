'use client';

// components/moments/use-moment-when.ts — the one "when" label both moments
// surfaces (HomeMomentCard, MomentsView) render: the reader's language, the
// family's clock (TIME-003), the catalogue's words.
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { useFamilyClock } from '@/components/i18n/use-format';
import { momentWhen } from '@/lib/moments/prep';

export function useMomentWhen(): (startsAt: string, allDay: boolean) => string {
  const locale = useLocale();
  const t = useTranslations();
  const clock = useFamilyClock();
  return (startsAt, allDay) => momentWhen(startsAt, allDay, new Date(), locale.code, t, clock.timeZone); // instant: now is compared in the family's zone inside momentWhen
}
