// A balance read outside the lock is not what approves a card.
//
// `lib/wallet/server.ts` exported a `childSpendableCents` whose docstring said
// "This is what a card authorization is checked against in real time." Nothing
// called it, and the sentence was false — which is the part that mattered. A
// card authorization goes through `reserveCardAuth`, whose RPC re-checks the
// balance in SQL under a per-child lock precisely so two concurrent
// authorizations cannot each approve against the same money. A TypeScript sum
// taken outside that lock cannot give the same answer, so a future caller who
// trusted the comment for a money decision would have had a race, not a balance.
//
// The deadness was the harmless half. These cases pin the half that was not.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const wallet = readFileSync('lib/wallet/server.ts', 'utf8');
const webhook = readFileSync('lib/stripe/webhook.ts', 'utf8');

describe('a card authorization is decided under the lock', () => {
  it('goes through the locking RPC, not a client-side sum', () => {
    const reserve = wallet.slice(wallet.indexOf('export async function reserveCardAuth'));
    expect(reserve).toContain("rpc('wallet_reserve_card_auth'");
    // And the caller that actually spends money uses it.
    expect(webhook).toContain('reserveCardAuth(');
  });

  it('the approve/decline decision comes from the reservation, not from a balance', () => {
    // Asserted on CODE, not on prose. The first version of this case matched the
    // false docstring's wording and went red on the comment that now explains why
    // that docstring was wrong — a regex cannot tell a claim from a warning about
    // the claim, and the property was never about wording anyway.
    const branch = webhook.slice(webhook.indexOf('const reserved = await reserveCardAuth('),
      webhook.indexOf('// Tell Stripe.'));
    expect(branch).toMatch(/decision = reserved \?/);
    // Nothing in that branch reaches for a summed balance to decide with.
    expect(branch).not.toMatch(/BalanceCents|SpendableCents/);
  });

  it('the dead helper is gone, and did not come back somewhere else', () => {
    const files = execSync("git ls-files 'app/**/*.ts*' 'lib/**/*.ts*' 'components/**/*.ts*'", { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    // Comments are stripped: lib/wallet/server.ts explains in prose why the
    // helper was removed, and a guard that reads source as text has to read CODE
    // as text — the same mistake cost a CI run earlier in this audit.
    const code = (file: string) => readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(files.filter((f) => /childSpendableCents/.test(code(f)))).toEqual([]);
  });

  it('the balance helper that IS for display pages its read', () => {
    // Kept because the original finding paired the two: PostgREST caps a
    // response at db-max-rows whatever the client asked, so an unbounded sum
    // over a busy ledger totals a fraction of it and reports a balance that is
    // not the child's. That half is already fixed, and this says so.
    const display = wallet.slice(wallet.indexOf('export async function bucketBalanceCents'));
    expect(display).toContain('readAll<');
  });
});
