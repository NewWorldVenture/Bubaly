// One read boundary for the wishlist panel and the assistant's purchase check.
// The pure advisor decides; this service supplies only the caller's household
// records, subject to the existing finance and memory role policies.
import 'server-only';
import { budgetVsActual } from '@/lib/services/finances';
import { recallFacts } from '@/lib/services/memory';
import { readAllPages } from '@/lib/supabase/read-all-pages';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { adviseOnPurchase, type BudgetRow, type FactRow, type PurchaseAdvice } from '@/lib/purchases/advisor';

export type PurchaseAdvisorResult = { advice: PurchaseAdvice; budgetRestricted: boolean; memoryRestricted: boolean };
export type BeforeYouBuyInput = {
  /** What the family is thinking of buying — a wish title or free text. */
  text: string;
  url?: string | null;
  /** Dollars, as typed on the wish. */
  priceDollars?: number | null;
  budgetCategory?: string | null;
  /**
   * The wish this was opened from, when it was opened from one. Its own row is
   * not evidence about itself, so it is dropped before the advisor sees the
   * family's lists.
   */
  excludeWishId?: string | null;
};

export async function advisePurchase(scope: ServiceScope, input: BeforeYouBuyInput): Promise<ServiceResult<PurchaseAdvisorResult>> {
  const familyId = scope.familyId;

  const text = typeof input?.text === 'string' ? input.text.trim().slice(0, 500) : '';
  if (!text) return fail('Say what you are thinking of buying.', { code: SERVICE_CODES.invalidInput });

  const supabase = scope.db;
  try {
    // A person can browse their own saved facts; an assistant must honour
    // the memory switch before loading any of them for its answer.
    let memoryRestricted = false;
    if (scope.actorKind !== 'member') {
      const settings = await supabase.from('family_ai_settings').select('memory_enabled').eq('family_id', familyId).maybeSingle();
      if (settings.error) {
        console.error('[purchase-advisor] memory settings read failed', settings.error);
        return fail('Could not check memory settings.', { code: SERVICE_CODES.db, retryable: true });
      }
      memoryRestricted = settings.data?.memory_enabled === false;
    }
    const [inventory, locations, assets, wardrobe, wishes, facts] = await Promise.all([
      readAllPages((from, to) => supabase
        .from('inventory_items')
        .select('id, name, category, location_id, quantity, value_cents, brand, model, serial_number, tags, status, lent_to, lent_on, warranty_until')
        .eq('family_id', familyId)
        .order('id').range(from, to)),
      readAllPages((from, to) => supabase.from('home_locations').select('id, name, kind, parent_id').eq('family_id', familyId).order('id').range(from, to)),
      readAllPages((from, to) => supabase
        .from('home_assets')
        .select('id, name, category, location, brand, model, serial_number, purchase_price, warranty_until')
        .eq('family_id', familyId)
        .order('id').range(from, to)),
      readAllPages((from, to) => supabase
        .from('wardrobe_items')
        .select('id, member_id, name, category, brand, color, size, status, price_cents')
        .eq('family_id', familyId)
        .order('id').range(from, to)),
      readAllPages((from, to) => supabase
        .from('wishlist_items')
        .select('id, member_id, title, price, is_purchased')
        .eq('family_id', familyId)
        .order('id').range(from, to)),
      // Memories come through the memory service, never a raw query: it is what
      // hides medical and account facts (and sensitive wording in any category)
      // from a child or teen, and drops facts whose `expires_at` has passed. A
      // raw select would put last winter's coat size and "Liam — peanut allergy"
      // in front of whoever opened the panel.
      memoryRestricted ? Promise.resolve(ok([])) : recallFacts(scope, { complete: true }),
    ]);

    const failed = [
      ['inventory_items', inventory.error],
      ['home_locations', locations.error],
      ['home_assets', assets.error],
      ['wardrobe_items', wardrobe.error],
      ['wishlist_items', wishes.error],
      ['family_facts', facts.ok ? null : facts.error],
    ].find(([, error]) => Boolean(error));

    if (failed) {
      console.error(`[purchase-advisor] ${failed[0]} read failed`, failed[1]);
      return fail('Could not check what you already own. Refresh and try again.', { code: SERVICE_CODES.db, retryable: true });
    }

    const visibleFacts: FactRow[] = facts.ok
      ? facts.data.map((f) => ({
          id: f.id,
          member_id: f.member_id,
          category: f.category,
          label: f.label,
          value: f.value,
          is_pinned: f.is_pinned,
        }))
      : [];

    // Budgets carry the household's money, so they come through the finance
    // service and its role boundary rather than a raw query. A refusal is not a
    // read failure: the advice still stands, minus the affordability half.
    let budgets: BudgetRow[] = [];
    let budgetRestricted = false;
    const status = await budgetVsActual(scope, { complete: true });
    if (!status.ok) {
      if (status.code === SERVICE_CODES.denied) {
        budgetRestricted = true;
      } else {
        console.error('[purchase-advisor] budgets read failed', status.error, status.code);
        return fail('Could not check what you already own. Refresh and try again.', { code: SERVICE_CODES.db, retryable: true });
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
      facts: visibleFacts,
      budgets,
      // A wish is not evidence about itself, and gift state is never shown to the
      // person the wish belongs to.
      excludeWishId: input.excludeWishId ?? null,
      viewerMemberId: scope.memberId,
    });

    return ok({ advice, budgetRestricted, memoryRestricted });
  } catch (error) {
    console.error('[purchase-advisor] household read failed', error);
    return fail('Could not check what you already own. Refresh and try again.', { code: SERVICE_CODES.db, retryable: true });
  }
}
