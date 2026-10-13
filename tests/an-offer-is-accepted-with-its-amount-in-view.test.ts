import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as listings from '@/lib/marketplace/listings';
import { between } from './helpers/source-order';

/**
 * An owner accepts an offer with its amount in view.
 *
 * `marketplace_accept_offer` records the order at
 * `coalesce(offer.amount_cents, listing.price_cents)`, so an offer that carries
 * an amount is accepted AT that amount. The owner's "Offers on …" dialog in the
 * marketplace module showed the offerer's name and message and dropped the
 * amount, so an owner could accept $1 for a $120 stroller without ever seeing
 * the $1 (the app's own buttons send no amount; the offers insert policy lets a
 * family member set one directly). The listing page's offer inbox already
 * showed it; both now take it from one helper, in the reader's notation.
 */
const offerAmountLabel = (listings as Record<string, unknown>).offerAmountLabel as
  | ((cents: number | null | undefined, locale: 'en-US' | 'de-DE' | 'fr-FR') => string)
  | undefined;

describe('an offer\'s amount, as the owner reads it', () => {
  it('is the amount in the reader\'s notation', () => {
    expect(offerAmountLabel).toBeTypeOf('function');
    expect(offerAmountLabel!(100, 'en-US')).toBe(listings.formatCents(100, 'en-US'));
    expect(offerAmountLabel!(12_000, 'de-DE')).toBe(listings.formatCents(12_000, 'de-DE'));
    expect(offerAmountLabel!(12_050, 'fr-FR')).toBe(listings.formatCents(12_050, 'fr-FR'));
  });

  it('is nothing for an offer without one', () => {
    expect(offerAmountLabel!(null, 'en-US')).toBe('');
    expect(offerAmountLabel!(undefined, 'en-US')).toBe('');
  });

  // Owner coordinator finding AUD-1037-MARKETPLACE-BOUNDARIES: a zero offer
  // was blank, as if it named no amount. Accepting records
  // `coalesce(offer.amount_cents, price)`, which keeps a zero, so the owner
  // could accept an order at nothing without seeing it.
  it('is zero, in the reader\'s notation, for an offer of zero', () => {
    expect(offerAmountLabel!(0, 'en-US')).toBe(listings.formatCents(0, 'en-US'));
    expect(offerAmountLabel!(0, 'de-DE')).toBe(listings.formatCents(0, 'de-DE'));
    expect(offerAmountLabel!(0, 'en-US')).not.toBe('');
  });
});

describe('where the owner accepts an offer', () => {
  it('the marketplace module\'s offers dialog shows each offer\'s amount', () => {
    const src = readFileSync('components/modules/marketplace-module.tsx', 'utf8');
    const dialog = between(src, 'dialogOffers.map((o) =>', "t('marketplace.accept')}</Button>");
    expect(dialog).toContain('offerAmountLabel(o.amount_cents, locale.code)');
  });

  it('the marketplace module\'s offers dialog leaves out only a missing amount, never a zero one', () => {
    const src = readFileSync('components/modules/marketplace-module.tsx', 'utf8');
    const dialog = between(src, 'dialogOffers.map((o) =>', "t('marketplace.accept')}</Button>");
    expect(dialog).toContain('o.amount_cents != null ?');
    // A truthiness gate hides a zero offer the owner would accept at zero.
    expect(dialog).not.toMatch(/\{\s*o\.amount_cents\s*(\?|&&)/);
  });

  it('the listing page\'s inbox takes it from the same helper', () => {
    const src = readFileSync('app/(app)/marketplace/item/[id]/page.tsx', 'utf8');
    expect(src).toContain('amount: offerAmountLabel(o.amount_cents, locale.code),');
  });
});
