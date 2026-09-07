'use server';

// "Before you buy" — the server half of the Household Purchase Advisor (M17).
//
// It assembles the family's OWN rows, family-scoped and fail-closed, and hands
// them to the pure advisor in lib/purchases/advisor.ts. Nothing is written:
// this is a read-only second opinion the family can ignore.
//
// FAIL CLOSED. Every read is checked. A failed read returns a retryable error
// rather than an advice object with an empty `duplicates` array — "you don't
// own one of these" read off a query that never ran is exactly the reassuring
// lie the honesty rule exists to stop.

import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { budgetVsActual } from '@/lib/services/finances';
import { SERVICE_CODES } from '@/lib/services/types';
import {
  adviseOnPurchase,
  type BudgetRow,
  type PurchaseAdvice,
} from '@/lib/purchases/advisor';

export type BeforeYouBuyInput = {
  /** What the family is thinking of buying — a wish title or free text. */
  text: string;
  url?: string | null;
  /** Dollars, as typed on the wish. */
  priceDollars?: number | null;
  budgetCategory?: string | null;
};

export type BeforeYouBuyResult =
  | {
      ok: true;
      advice: PurchaseAdvice;
      /**
       * True when the caller's role may not read the household's finances, so
       * the budget half was never attempted. The panel says so rather than
       * implying the money side came back clear.
       */
      budgetRestricted: boolean;
    }
  | { ok: false; error: string };

const MAX_ROWS = 400;

export async function adviseBeforeBuying(input: BeforeYouBuyInput): Promise<BeforeYouBuyResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;

  const text = (input?.text ?? '').trim();
  if (!text) return { ok: false, error: t('wishlistsActions.sayWhatYouReThinking') };

  const supabase = await createServer();

  const [inventory, locations, assets, wardrobe, wishes, facts] = await Promise.all([
    supabase
      .from('inventory_items')
      .select('id, name, category, location_id, quantity, value_cents, brand, model, serial_number, tags, status, lent_to, lent_on, warranty_until')
      .eq('family_id', familyId)
      .limit(MAX_ROWS),
    supabase.from('home_locations').select('id, name, kind, parent_id').eq('family_id', familyId).limit(MAX_ROWS),
    supabase
      .from('home_assets')
      .select('id, name, category, location, brand, model, serial_number, purchase_price, warranty_until')
      .eq('family_id', familyId)
      .limit(MAX_ROWS),
    supabase
      .from('wardrobe_items')
      .select('id, member_id, name, category, brand, color, size, status, price_cents')
      .eq('family_id', familyId)
      .limit(MAX_ROWS),
    supabase
      .from('wishlist_items')
      .select('id, member_id, title, price, is_purchased')
      .eq('family_id', familyId)
      .limit(MAX_ROWS),
    supabase
      .from('family_facts')
      .select('id, member_id, category, label, value, is_pinned')
      .eq('family_id', familyId)
      .limit(MAX_ROWS),
  ]);

  const failed = [
    ['inventory_items', inventory.error],
    ['home_locations', locations.error],
    ['home_assets', assets.error],
    ['wardrobe_items', wardrobe.error],
    ['wishlist_items', wishes.error],
    ['family_facts', facts.error],
  ].find(([, error]) => Boolean(error));

  if (failed) {
    console.error(`[purchase-advisor] ${failed[0]} read failed`, failed[1]);
    return { ok: false, error: t('wishlistsActions.couldNotCheckWhatYou') };
  }

  // Budgets carry the household's money, so they come through the finance
  // service and its role boundary rather than a raw query. A refusal is not a
  // read failure: the advice still stands, minus the affordability half.
  let budgets: BudgetRow[] = [];
  let budgetRestricted = false;
  const scope = scopeFromUserContext(ctx, supabase);
  const status = await budgetVsActual(scope);
  if (!status.ok) {
    if (status.code === SERVICE_CODES.denied) {
      budgetRestricted = true;
    } else {
      console.error('[purchase-advisor] budgets read failed', status.error, status.code);
      return { ok: false, error: t('wishlistsActions.couldNotCheckWhatYou') };
    }
  } else {
    budgets = status.data.budgets.map((line) => ({
      category: line.category,
      limitCents: Math.round(line.limit * 100),
      spentCents: Math.round(line.spent * 100),
    }));
  }

  const priceDollars = typeof input.priceDollars === 'number' && Number.isFinite(input.priceDollars) ? input.priceDollars : null;

  const advice = adviseOnPurchase({
    candidate: {
      text,
      url: input.url ?? null,
      priceCents: priceDollars !== null && priceDollars > 0 ? Math.round(priceDollars * 100) : null,
      budgetCategory: input.budgetCategory ?? null,
    },
    inventory: inventory.data ?? [],
    locations: locations.data ?? [],
    homeAssets: assets.data ?? [],
    wardrobe: wardrobe.data ?? [],
    wishes: wishes.data ?? [],
    facts: facts.data ?? [],
    budgets,
  });

  return { ok: true, advice, budgetRestricted };
}
