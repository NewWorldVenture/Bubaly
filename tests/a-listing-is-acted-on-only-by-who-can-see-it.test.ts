// DB-RPC-M01 (0462): a family that cannot see a marketplace listing could bid
// on it, Buy-It-Now it, open a negotiation on it, and file an offer whose
// SECURITY DEFINER trigger flipped it to 'pending' — measured on a replayed
// database with nothing but the listing's id. The behaviour is proved in
// docs/audit/a-listing-is-acted-on-only-by-who-can-see-it-check.sql, which CI's
// Database job runs; this pins the shape so a later migration that redefines
// one of the functions cannot silently drop the check.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const MIGRATION = '0462_a_listing_is_acted_on_only_by_who_can_see_it.sql';
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const migration = read(MIGRATION);

// The body of the LAST migration that (re)defines `fn`, so a redefinition after
// 0462 is what gets checked, not 0462's.
function latestBody(fn: string): { file: string; body: string } {
  const head = new RegExp(`create or replace function public\\.${fn}\\s*\\(`, 'i');
  for (const f of [...files].reverse()) {
    const src = read(f);
    const at = src.search(head);
    if (at < 0) continue;
    const rest = src.slice(at);
    const tag = rest.match(/\bas\s+(\$[a-z_]*\$)/i)?.[1];
    if (!tag) throw new Error(`${f}: no dollar-quoted body for ${fn}`);
    const open = rest.indexOf(tag);
    const close = rest.indexOf(tag, open + tag.length);
    return { file: f, body: rest.slice(open + tag.length, close) };
  }
  throw new Error(`no migration defines ${fn}`);
}

describe('a listing is acted on only by a family that can see it (DB-RPC-M01)', () => {
  it.each([
    ['marketplace_place_bid', 'p_listing_id', 'p_bidder_family_id', 'marketplace_place_bid_unchecked('],
    ['marketplace_buy_now', 'p_listing_id', 'p_buyer_family_id', 'update public.marketplace_listings'],
    ['marketplace_negotiation_offer', 'p_listing', 'p_buyer_family', 'from public.marketplace_listings where id = p_listing for update'],
  ])('%s asks whether the acting family can see the listing before it touches it', (fn, listing, family, firstAct) => {
    const { file, body } = latestBody(fn);
    const guard = `public.marketplace_listing_visible_to(${listing}, ${family})`;
    expect(body, `${file} redefines ${fn} without the visibility check`).toContain(guard);
    const guardAt = body.indexOf(guard);
    const actAt = body.indexOf(firstAct);
    expect(actAt, `${fn}: could not find where it first acts (${firstAct})`).toBeGreaterThan(-1);
    expect(guardAt, `${fn} acts on the listing before asking`).toBeLessThan(actAt);
    // A refusal every caller already maps ("that listing no longer exists").
    expect(body.slice(guardAt, guardAt + 200)).toContain("'reason', 'not_found'");
  });

  it('the rule is the two read policies as one predicate, and names its caller', () => {
    const helper = migration.slice(migration.indexOf('create or replace function public.marketplace_listing_visible_to'));
    const body = helper.slice(0, helper.indexOf('$$;') + 3);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = public, pg_temp/);
    expect(body).toContain('public.is_family_member(p_family_id)');
    expect(body).toContain('l.family_id = p_family_id');
    expect(body).toMatch(/marketplace_listing_shares s\s+join public\.marketplace_circle_members m on m\.circle_id = s\.circle_id/);
    expect(migration).toContain('revoke all on function public.marketplace_listing_visible_to(uuid, uuid) from public, anon;');
  });

  it("an offer's listing is the offer's own family's (0311's guard, wired)", () => {
    expect(migration).toMatch(
      /create trigger trg_marketplace_offers_listing_id_family\s+before insert or update of listing_id, family_id on public\.marketplace_offers\s+for each row execute function public\.reference_shares_family\('listing_id', 'marketplace_listings'\);/,
    );
  });

  it.each(['marketplace_questions', 'marketplace_saves', 'marketplace_collection_items'])(
    '%s takes only a listing the family can see',
    (table) => {
      expect(migration).toMatch(new RegExp(
        `create policy ${table}_listing_is_visible on public\\.${table}\\s+as restrictive for insert to authenticated\\s+` +
        `with check \\(public\\.marketplace_listing_visible_to\\(listing_id, family_id\\)\\);`,
      ));
    },
  );

  it('the liveness probe negotiates on a listing the buyer can see, as the product does', () => {
    const probe = readFileSync('docs/audit/marketplace-rpc-liveness-check.sql', 'utf8');
    const share = probe.indexOf('insert into public.marketplace_listing_shares');
    const offer = probe.indexOf('public.marketplace_negotiation_offer(');
    expect(share).toBeGreaterThan(-1);
    expect(share).toBeLessThan(offer);
  });
});
