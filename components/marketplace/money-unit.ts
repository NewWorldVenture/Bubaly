'use client';

// The currency unit inside a marketplace money input, in the READER's notation.
//
// The bid box, the offer box, the counter box and Quick Post's price box each
// drew a literal "$" pinned to the LEFT of the field. Every amount printed
// around those boxes now follows the reader's locale, so a German bidder saw a
// "$ [   ]" box directly under "Max bid (min 2.768,50 $)". This reads the symbol
// and its side from the same Intl formatter (lib/marketplace/listings.ts
// currencyUnit) and hands back the classes that put it there.
import { useMemo } from 'react';

import { useLocale } from '@/components/i18n/locale-provider';
import { currencyUnit } from '@/lib/marketplace/listings';

export type MoneyUnit = {
  /** "$" in en-US and de-DE, "$US" in fr-FR. */
  symbol: string;
  /** Positions the adornment: `left-3` when the unit leads, `right-3` when it trails. */
  unitClass: string;
  /** The input's horizontal padding, leaving room for the unit on its side. */
  padClass: string;
};

export function useMoneyUnit(): MoneyUnit {
  const locale = useLocale();
  return useMemo(() => {
    const { symbol, before } = currencyUnit(locale.code);
    // A one-glyph "$" fits in 1.75rem; "$US" needs about 2.75rem.
    const wide = symbol.length > 1;
    // Literal class strings, not built ones, so Tailwind's scanner sees each.
    if (before) return { symbol, unitClass: 'left-3', padClass: wide ? 'pl-11 pr-3' : 'pl-7 pr-3' };
    return { symbol, unitClass: 'right-3', padClass: wide ? 'pl-3 pr-11' : 'pl-3 pr-7' };
  }, [locale.code]);
}
