import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/0184_marketplace_auction_authorization.sql', 'utf8');
const closeMigration = readFileSync('supabase/migrations/0185_marketplace_auction_close_transaction.sql', 'utf8');
const actions = readFileSync('app/(app)/marketplace/auctions/actions.ts', 'utf8');
const closeRoute = readFileSync('app/api/cron/close-auctions/route.ts', 'utf8');

describe('marketplace auction security contract', () => {
  it('removes direct authenticated bid inserts and authenticates RPC member identity', () => {
    expect(migration).toContain('revoke insert on public.marketplace_bids from anon, authenticated');
    expect(migration).toContain('auth.uid() is null');
    expect(migration).toContain('user_id = auth.uid() and is_active');
    expect(migration).toContain('v_member_family is distinct from p_bidder_family_id');
    expect(migration).toContain("to_regprocedure('public.marketplace_place_bid(uuid,uuid,uuid,bigint)')");
  });

  it('keeps Buy-It-Now in a single database transaction', () => {
    expect(migration).toContain('create or replace function public.marketplace_buy_now');
    expect(migration).toContain('for update;');
    expect(migration).toContain('insert into public.marketplace_orders');
    expect(actions).toContain("supabase.rpc('marketplace_buy_now'");
    expect(actions).not.toContain(".update({ status: 'claimed'");
  });

  it('settles expired auctions atomically before notifying users', () => {
    expect(closeMigration).toContain('create or replace function public.marketplace_close_auction');
    expect(closeMigration).toContain("current_user <> 'service_role'");
    expect(closeMigration).toContain('for update;');
    expect(closeMigration).toContain('insert into public.marketplace_orders');
    expect(closeMigration).toContain('grant execute on function public.marketplace_close_auction(uuid, timestamptz) to service_role');
    expect(closeRoute).toContain("admin.rpc('marketplace_close_auction'");
    expect(closeRoute).not.toContain(".from('marketplace_orders').insert");
    expect(closeRoute).not.toContain(".from('marketplace_listings')\n    .update");
  });
});
