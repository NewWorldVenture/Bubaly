import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/0184_marketplace_auction_authorization.sql', 'utf8');
const closeMigration = readFileSync('supabase/migrations/0185_marketplace_auction_close_transaction.sql', 'utf8');
const actions = readFileSync('app/(app)/marketplace/auctions/actions.ts', 'utf8');
const closeRoute = readFileSync('app/api/cron/close-auctions/route.ts', 'utf8');

// 0184 and 0185 are where these functions were first written; later migrations
// replace them. What the database runs is the LAST `create or replace`, so the
// contract is read from there: the function's own text, comments removed, and
// the statements that follow it in the same migration (its grants).
const MIGRATIONS = 'supabase/migrations';
function liveDefinition(name: string): { file: string; body: string; after: string } {
  const header = `create or replace function public.${name}(`;
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
    if (sql.toLowerCase().includes(header)) found = { file, sql };
  }
  if (!found) throw new Error(`no migration defines public.${name}`);
  const start = found.sql.toLowerCase().lastIndexOf(header);
  const tag = /\bas (\$[a-z_]*\$)/i.exec(found.sql.slice(start));
  if (!tag) throw new Error(`${found.file}: public.${name} has no dollar-quoted body`);
  const open = start + tag.index + tag[0].length;
  const close = found.sql.indexOf(tag[1], open);
  if (close === -1) throw new Error(`${found.file}: public.${name} body never closes`);
  const body = found.sql.slice(open, close).split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
  return { file: found.file, body, after: found.sql.slice(close) };
}

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

  it('still authenticates the bidder in the definition the database runs today', () => {
    const bid = liveDefinition('marketplace_place_bid');
    expect(bid.file > '0184_marketplace_auction_authorization.sql', bid.file).toBe(true);
    expect(bid.body).toContain('auth.uid() is null');
    expect(bid.body).toContain('where id = p_bidder_member_id and user_id = auth.uid() and is_active;');
    expect(bid.body).toContain('v_member_family is null or v_member_family is distinct from p_bidder_family_id');
    // The checks come before the hand-off to the unchecked writer.
    const handOff = bid.body.indexOf('return public.marketplace_place_bid_unchecked(');
    expect(handOff).toBeGreaterThan(bid.body.indexOf('v_member_family is distinct from p_bidder_family_id'));
    expect(bid.after).toContain('revoke all on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) from public, anon;');

    // The writer it hands off to is the server's alone.
    const unchecked = liveDefinition('marketplace_place_bid_unchecked');
    expect(unchecked.after).toContain(
      'revoke all on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) from public, anon, authenticated;',
    );

    // And no later migration hands the direct insert back to a client role.
    const regrants = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > '0184_marketplace_auction_authorization.sql')
      .filter((f) => /grant\s[^;]*\b(?:insert|all)\b[^;]*\bon\s+(?:table\s+)?public\.marketplace_bids\s+to\s[^;]*\b(?:anon|authenticated|public)\b/i
        .test(readFileSync(`${MIGRATIONS}/${f}`, 'utf8')));
    expect(regrants).toEqual([]);
  });

  it('still locks the listing and writes the order in the Buy-It-Now the database runs today', () => {
    const buy = liveDefinition('marketplace_buy_now');
    expect(buy.file > '0184_marketplace_auction_authorization.sql', buy.file).toBe(true);
    expect(buy.body).toContain('auth.uid() is null');
    expect(buy.body).toContain('where id = p_buyer_member_id and user_id = auth.uid() and is_active;');
    const lock = buy.body.search(/from public\.marketplace_listings\s+where id = p_listing_id\s+for update;/);
    const order = buy.body.indexOf('insert into public.marketplace_orders');
    expect(lock).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(lock);
  });

  it('lets the service role, and only it, settle in the close function the database runs today', () => {
    // 0185's guard, `current_user <> 'service_role'`, is true for every caller
    // of a SECURITY DEFINER function, so it refused every settlement (0457,
    // DB-FN-003). The live guard reads the caller's role from the request.
    const close = liveDefinition('marketplace_close_auction');
    expect(close.file > '0185_marketplace_auction_close_transaction.sql', close.file).toBe(true);
    expect(close.body).toContain("if coalesce(auth.role(), '') <> 'service_role' then\n    raise exception 'forbidden';");
    expect(close.body).not.toMatch(/\bcurrent_user\b/);
    const lock = close.body.search(/from public\.marketplace_listings\s+where id = p_listing_id\s+for update;/);
    const order = close.body.indexOf('insert into public.marketplace_orders');
    expect(lock).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(lock);
    expect(close.after).toContain(
      'revoke all on function public.marketplace_close_auction(uuid, timestamptz) from public, anon, authenticated;',
    );
    expect(close.after).toContain('grant execute on function public.marketplace_close_auction(uuid, timestamptz) to service_role;');
  });
});
