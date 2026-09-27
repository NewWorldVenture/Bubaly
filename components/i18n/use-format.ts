'use client';

// The shared formatters, bound to the locale the visitor is reading in.
//
// Same shape as `useTranslations()` next to it, deliberately: a client component
// that needs both writes
//
//   const t = useTranslations();
//   const { fmtDate, fmtMoney } = useFormat();
//
// and neither reaches for a locale itself. Importing `fmtDate` from
// '@/lib/utils/format' inside a rendered component is the defect this replaces —
// those bare exports are bound to en-US and are correct only where there is no
// reader whose language we know.
import { useMemo } from 'react';

import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { createFormat, type Format } from '@/lib/utils/format';

export function useFormat(): Format {
  const locale = useLocale();
  const t = useTranslations();
  // Memoised on the locale code: each formatter builds Intl objects, and a new
  // identity every render would defeat any useMemo downstream that depends on one.
  return useMemo(() => createFormat(locale.code, t), [locale.code, t]);
}
