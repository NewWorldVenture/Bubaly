import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

const actionFiles = [
  'app/(app)/feedback/actions.ts',
  'app/(app)/marketplace/actions.ts',
  'app/(app)/marketplace/alerts/actions.ts',
  'app/(app)/marketplace/community/actions.ts',
  'app/(app)/marketplace/report/actions.ts',
  'app/(app)/marketplace/handoff/actions.ts',
  'app/(app)/marketplace/negotiations/actions.ts',
];
const handoffMigration = readFileSync('supabase/migrations/0199_marketplace_handoff_completion.sql', 'utf8');
// 0483 replaced the function 0199 created; it is the definition that runs today.
const liveHandoffMigration = readFileSync('supabase/migrations/0483_a_live_hold_counts_and_an_order_names_both_families.sql', 'utf8');

describe('Marketplace and Feedback action boundaries', () => {
  it('does not return raw database messages to callers', () => {
    for (const file of actionFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('describeActionError(');
      expect(source, file).not.toMatch(/return \{ ok: false, error: [^\n}]*\.message/);
    }
  });

  it('fails closed on required marketplace reads before mutating', () => {
    const marketplace = readFileSync('app/(app)/marketplace/actions.ts', 'utf8');
    const handoff = readFileSync('app/(app)/marketplace/handoff/actions.ts', 'utf8');
    expect(marketplace).toContain("if (readError) return actionFailure('check the saved listing', t('marketplace.couldNotCheckTheSavedListing'), readError);");
    expect(marketplace).toContain("if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);");
    expect(marketplace).toContain("if (listingError) return actionFailure('load the listing', t('marketplace.couldNotLoadTheListing'), listingError);");
    expect(handoff).toContain("if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);");
    expect(handoff).toContain("if (handoffError) return actionFailure('load the pickup', t('handoff.couldNotLoadThePickup'), handoffError);");
  });

  it('keeps expected duplicate and domain messages explicit', () => {
    const feedback = readFileSync('app/(app)/feedback/actions.ts', 'utf8');
    const community = readFileSync('app/(app)/marketplace/community/actions.ts', 'utf8');
    const marketplace = readFileSync('app/(app)/marketplace/actions.ts', 'utf8');
    expect(feedback).toContain("error.code !== '23505'");
    expectTranslates(community, 'actions.noCircleFoundWithThat', "No circle found with that code — double-check it");
    expectTranslates(marketplace, 'actions.youAlreadyReviewedThisExchange', "You already reviewed this exchange");
    // I18N-002: an illegal order step is a stale screen, said in the viewer's
    // language and without echoing the caller-supplied status.
    expectTranslates(marketplace, 'marketplace.orderStepNoLongerAvailable', 'This order has moved on since you opened it. Refresh to see its current step.');
    expect(marketplace).not.toContain('Can’t go from ${');
  });

  it('completes the hand-off and order in one authorized transaction', () => {
    const handoff = readFileSync('app/(app)/marketplace/handoff/actions.ts', 'utf8');
    expect(handoff).toContain("'marketplace_complete_handoff'");
    expect(handoffMigration).toContain('create or replace function public.marketplace_complete_handoff');
    expect(handoffMigration).toContain('public.is_family_member(v_order.family_id)');
    expect(handoffMigration.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(handoffMigration).toContain("revoke all on function public.marketplace_complete_handoff(uuid, text) from public;");
    expect(handoffMigration).toContain("grant execute on function public.marketplace_complete_handoff(uuid, text) to authenticated;");
    expect(handoffMigration).toContain("set status = 'completed'");
    // 0199's membership check is what 0483 replaced: under it any sibling who
    // could read the code closed someone else's pickup. The authorization that
    // counts is the live function's, so read its own body.
    const header = 'CREATE OR REPLACE FUNCTION public.marketplace_complete_handoff(p_order_id uuid, p_code text)';
    const start = liveHandoffMigration.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    const end = liveHandoffMigration.indexOf('$function$;', start);
    expect(end).toBeGreaterThan(start);
    const live = liveHandoffMigration.slice(start, end);
    expect(live).toContain('v_seller_side := public.marketplace_member_id(v_order.family_id);');
    expect(live).toContain('v_buyer_side  := public.marketplace_member_id(coalesce(v_order.buyer_family_id, v_order.family_id));');
    expect(live).toContain('if not ((v_seller_side is not null and v_seller_side in (v_order.buyer_member, v_order.seller_member))');
    expect(live).toContain('or (v_buyer_side is not null and v_buyer_side = v_order.buyer_member)) then');
    expect(live).toContain("return jsonb_build_object('ok', false, 'reason', 'forbidden');");
    expect(live).not.toContain('is_family_member(');
    // the caller is refused before either row is written, and both rows are locked
    const forbidden = at(live, "'forbidden'");
    expect(forbidden).toBeLessThan(at(live, 'update public.marketplace_handoffs'));
    expect(forbidden).toBeLessThan(at(live, 'update public.marketplace_orders'));
    expect(live.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(live.match(/set status = 'completed'/g)?.length ?? 0).toBe(2);
    expect(liveHandoffMigration).toContain('revoke all on function public.marketplace_complete_handoff(uuid, text) from public, anon;');
    expect(liveHandoffMigration.slice(end)).toContain('grant execute on function public.marketplace_complete_handoff(uuid, text) to authenticated;');
  });
});
