import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserveMet } from '@/lib/marketplace/auction';

// SEC-016. In a proxy auction the leader's maximum is the one thing the
// mechanism depends on nobody knowing. 0183's own column comments call two
// values secret — `reserve_cents` "hidden floor", `highest_max_cents` "current
// leader's hidden proxy max" — and nothing hid them: every rival in a sharing
// circle could select both, and the seller could select every bidder's
// `max_cents`. Measured over PostgREST with three real accounts, a rival who
// bid exactly the leader's ceiling moved a $10.00 auction to $500.00, the
// leader's entire maximum, without ever taking the lead.
//
// 0328 fixes it with column privileges, and
// docs/audit/proxy-bid-ceiling-is-secret-check.sql holds the database half on
// every PR. This file holds the code half: after 0328 a client read that names
// a secret column fails with 42501, and so does `select('*')` on either table,
// so the code must never do either. Before 0328 the auction board was doing the
// first — serialising `reserve_cents` into the props of every viewer's page.

const SECRETS = ['reserve_cents', 'highest_max_cents', 'max_cents'] as const;
const TABLES = ['marketplace_listings', 'marketplace_bids'] as const;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && full !== join('lib', 'database.types.ts')) out.push(full);
    }
  };
  for (const root of ['app', 'components', 'lib']) walk(root);
  return out;
}

type Read = { file: string; line: number; table: string; columns: string };

/** Every `.from('<auction table>')…select('<columns>')` in a file, with its column string. */
export function auctionReads(file: string, source: string): Read[] {
  const reads: Read[] = [];
  for (const m of source.matchAll(/\.from\(\s*['"`](marketplace_listings|marketplace_bids)['"`]\s*\)([\s\S]{0,400}?)\.select\(\s*(?:(['"`])([\s\S]*?)\3|([A-Za-z_$][\w$]*)|\))/g)) {
    // A select that is a named constant is resolved to the constant's literal.
    let columns = m[4] ?? '*';
    if (m[5]) {
      const def = new RegExp(`const\\s+${m[5]}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`).exec(source);
      columns = def ? def[2] : `<unresolved ${m[5]}>`;
    }
    // Stop at a chain that ended before this select (another statement).
    if (/;\s*$/.test(m[2].split('\n')[0] ?? '')) continue;
    reads.push({ file, line: source.slice(0, m.index).split('\n').length, table: m[1], columns });
  }
  return reads;
}

/** Why a read will fail or leak after 0328, or null when it is fine. */
export function problemWith(read: Read): string | null {
  const cols = read.columns.split(',').map((c) => c.trim().split(/\s|:/)[0]);
  if (cols.includes('*') || read.columns.trim() === '') return `selects * from ${read.table}, which 0328 refuses to anon and authenticated`;
  if (read.columns.startsWith('<unresolved')) return `select list ${read.columns} could not be resolved, so it cannot be checked`;
  const named = cols.filter((c) => (SECRETS as readonly string[]).includes(c));
  return named.length ? `selects ${named.join(', ')} from ${read.table}` : null;
}

const reads = sourceFiles().flatMap((f) => auctionReads(f, readFileSync(f, 'utf8')));

describe('a proxy bid ceiling is secret (SEC-016)', () => {
  it('found the auction reads to judge', () => {
    expect(reads.length).toBeGreaterThanOrEqual(25);
    expect(reads.some((r) => r.table === 'marketplace_bids')).toBe(true);
  });

  it('no code selects a secret column or * from the auction tables', () => {
    const problems = reads
      .map((r) => ({ r, why: problemWith(r) }))
      .filter((x) => x.why)
      .map((x) => `${x.r.file}:${x.r.line} — ${x.why}`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('rejects the reads this finding was about', () => {
    // The auction board's select as it was, and the module's star read.
    const board = `sb.from('marketplace_listings').select('id, title, bid_count, reserve_cents, buy_now_cents')`;
    const star = `sb.from('marketplace_listings').select('*').eq('family_id', familyId)`;
    const bids = `sb.from('marketplace_bids').select('amount_cents, max_cents')`;
    expect(problemWith(auctionReads('x.ts', board)[0])).toMatch(/selects reserve_cents/);
    expect(problemWith(auctionReads('x.ts', star)[0])).toMatch(/selects \*/);
    expect(problemWith(auctionReads('x.ts', bids)[0])).toMatch(/selects max_cents/);
  });

  it('resolves a select list held in a constant', () => {
    // components/modules/marketplace-module.tsx names its columns in a constant;
    // an unresolved name must not read as "fine".
    const held = [
      "const COLS = 'id, title, reserve_cents' as const;",
      "sb.from('marketplace_listings').select(COLS)",
    ].join('\n');
    expect(problemWith(auctionReads('x.ts', held)[0])).toMatch(/selects reserve_cents/);
    const opaque = "sb.from('marketplace_listings').select(somethingElse)";
    expect(problemWith(auctionReads('x.ts', opaque)[0])).toMatch(/could not be resolved/);
  });

  it('the UI reads the two facts it shows, not the figure', () => {
    for (const file of [
      'app/(app)/marketplace/item/[id]/page.tsx',
      'app/(app)/marketplace/auctions/page.tsx',
      'components/marketplace/auction-panel.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('reserve_met');
      expect(source, file).toContain('has_reserve');
      expect(source, file).not.toMatch(/reserveCents/);
    }
  });

  it('the client type has no reserve figure in it', () => {
    const lib = readFileSync('lib/marketplace/auction.ts', 'utf8');
    expect(lib).toMatch(/export type AuctionView = Omit<AuctionListing, 'reserveCents'> & \{\s*hasReserve: boolean;\s*reserveMet: boolean;\s*\}/);
  });

  it('the generated column is the same rule as reserveMet()', () => {
    // The badge a bidder sees is computed in SQL; the outcome a close resolves
    // is computed in TypeScript. If they disagreed, the board could say
    // "Reserve met" on an item that then does not sell.
    const sql = readFileSync('supabase/migrations/0328_a_proxy_bid_ceiling_is_secret.sql', 'utf8');
    expect(sql).toMatch(/reserve_cents is null or \(bid_count > 0 and current_bid_cents >= reserve_cents\)/);
    const mirror = (reserve: number | null, current: number, count: number) =>
      reserve === null || (count > 0 && current >= reserve);
    for (const [reserve, current, count] of [[null, 0, 0], [5000, 0, 0], [5000, 4900, 3], [5000, 5000, 4], [5000, 9000, 0]] as const) {
      expect(reserveMet({ reserveCents: reserve, currentBidCents: current, bidCount: count }), `${reserve}/${current}/${count}`)
        .toBe(mirror(reserve, current, count));
    }
  });

  it('the migration computes its grant list and checks itself', () => {
    const sql = readFileSync('supabase/migrations/0328_a_proxy_bid_ceiling_is_secret.sql', 'utf8');
    expect(sql).toContain("revoke select on public.%I from anon, authenticated");
    expect(sql).toMatch(/a\.attname <> all \(v_secrets\)/);
    expect(sql).toContain("0328: secret columns still client-selectable");
    expect(sql).toContain("0328: ordinary columns lost their SELECT grant");
  });

  it('the database half is held by a probe that runs on every PR', () => {
    const probe = readFileSync('docs/audit/proxy-bid-ceiling-is-secret-check.sql', 'utf8');
    for (const phrase of ["BREACH: a rival read the leader''s proxy ceiling", "BREACH: the seller read the bidders'' maxima", 'CONTROL FAILED', 'REGRESSION: ordinary columns are not selectable']) {
      expect(probe).toContain(phrase);
    }
    for (const table of TABLES) expect(probe).toContain(table);
  });
});
