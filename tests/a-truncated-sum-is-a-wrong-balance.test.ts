import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bucketBalanceCents } from '@/lib/wallet/server';

/**
 * A wallet balance is derived by summing the immutable ledger. Three functions
 * did it with a bare, unbounded `select()`.
 *
 * lib/supabase/read-all.ts already states the rule, and states it about exactly
 * this: "PostgREST answers an unbounded `select()` with at most `db-max-rows` —
 * 1,000 on a default Supabase project — and says nothing about it. No error, no
 * header the client surfaces, no short-read signal: the caller simply receives
 * 1,000 rows and believes that is the table." And, at the end of the same
 * header: "a truncated list is a display bug; a truncated sum is a wrong number
 * presented as a right one."
 *
 * The rule was written down. The three places that sum the ledger to decide
 * whether a child may spend did not follow it:
 *
 *   lib/wallet/server.ts  childSpendableCents  — "what a card authorization is
 *                                                checked against in real time"
 *   lib/wallet/server.ts  bucketBalanceCents   — "Used to validate spend +
 *                                                transfers so a wallet can never
 *                                                overdraw"
 *   app/(app)/wallet/invest/actions.ts         — the INVEST bucket balance
 *
 * None of them ordered the read either, so it was not merely a prefix — it was
 * an UNDETERMINED prefix. Drop debits and the balance reads high and an
 * authorization is approved against money that is not there; drop credits and
 * legitimate spending is declined. This PR already fixed the same defect in the
 * ledger reconciler, where the finding was recorded as "a ledger reconciled from
 * its newest 20,000 rows is not incomplete, it is arithmetically wrong".
 */

type Row = { id: string; direction: 'credit' | 'debit'; amount_cents: number; status: string };

/** 2,500 completed credits of 100 cents: a plainly correct total of 250,000. */
const LEDGER: Row[] = Array.from({ length: 2500 }, (_, i) => ({
  id: String(i).padStart(6, '0'),
  direction: 'credit' as const,
  amount_cents: 100,
  status: 'completed',
}));

const SERVER_CAP = 1000;

/**
 * A PostgREST stand-in that behaves the way a real one does at the boundary this
 * is about: it NEVER returns more than `SERVER_CAP` rows, whatever was asked
 * for, and it says nothing when it truncates.
 */
function cappedClient(rows: Row[]) {
  const builder = (table: string) => {
    let range: { from: number; to: number } | null = null;
    const self: Record<string, unknown> = {
      select() { return self; },
      eq() { return self; },
      in() { return self; },
      order() { return self; },
      range(from: number, to: number) { range = { from, to }; return self; },
      maybeSingle() {
        return Promise.resolve(
          table === 'wallet_buckets'
            ? { data: { id: 'bucket-1' }, error: null }
            : { data: null, error: null },
        );
      },
      // Awaiting the builder is the unbounded read.
      then(resolve: (v: unknown) => unknown) {
        const slice = range
          ? rows.slice(range.from, range.to + 1).slice(0, SERVER_CAP)
          : rows.slice(0, SERVER_CAP);
        return Promise.resolve({ data: slice, error: null }).then(resolve);
      },
    };
    return self;
  };
  return { from: builder } as never;
}

describe('a truncated sum is a wrong balance', () => {
  it('sums the WHOLE ledger even when the server caps every response', async () => {
    const result = await bucketBalanceCents(cappedClient(LEDGER), {
      familyId: 'fam-1',
      childWalletId: 'child-1',
      kind: 'spend',
    });

    expect(result.error).toBeUndefined();
    expect(result.available).toBe(250_000);
  });

  it('would have been wrong without paging — the calibration', () => {
    // What a bare unbounded select against the same server yields. This is the
    // number the three functions used to return, and it is not marked as partial
    // in any way: it is simply 60% of the child's money, presented as the balance.
    const truncated = LEDGER.slice(0, SERVER_CAP)
      .reduce((s, t) => s + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents), 0);

    expect(truncated).toBe(100_000);
    expect(
      truncated,
      'the capped client is not actually capping, so the test above proves nothing',
    ).not.toBe(250_000);
  });
});

/**
 * The ratchet. A function that SUMS the ledger must page; one that LISTS it need
 * not, and read-all.ts draws that line itself ("Pass `failOnMax: false` only
 * where the rows are LISTED rather than summed"). So this is scoped to the three
 * balance derivations by name rather than to every read of the table — the six
 * other `wallet_transactions` statements are three writes and three bounded
 * reads, and sweeping those in would be asserting something untrue about them.
 */
const LEDGER_SUMS: { file: string; fn: string }[] = [
  { file: 'lib/wallet/server.ts', fn: 'childSpendableCents' },
  { file: 'lib/wallet/server.ts', fn: 'bucketBalanceCents' },
  { file: 'app/(app)/wallet/invest/actions.ts', fn: 'investBucket' },
];

/** The body of `fn`, from its declaration to the next top-level close. */
function bodyOf(source: string, fn: string): string {
  const start = source.indexOf(`function ${fn}`);
  if (start < 0) return '';
  const rest = source.slice(start);
  const end = rest.indexOf('\n}\n');
  return end < 0 ? rest : rest.slice(0, end);
}

describe('every ledger sum pages', () => {
  it('finds each function it claims to cover', () => {
    // Non-vacuity: a renamed function would otherwise make this whole block
    // assert over empty strings and pass.
    for (const { file, fn } of LEDGER_SUMS) {
      expect(bodyOf(readFileSync(file, 'utf8'), fn).length, `${file}: ${fn} not found`).toBeGreaterThan(100);
    }
  });

  it('reads through readAll with a stable order, not a bare select', () => {
    const offenders: string[] = [];
    for (const { file, fn } of LEDGER_SUMS) {
      const body = bodyOf(readFileSync(file, 'utf8'), fn);
      if (!body.includes('readAll<')) offenders.push(`${file}: ${fn} does not page`);
      // readAll's own header: "an unordered paged read can repeat or skip rows
      // between pages". For a sum either one is a wrong total, so the order is
      // not optional here the way it is for a list.
      else if (!/\.order\(/.test(body)) offenders.push(`${file}: ${fn} pages without an .order()`);
    }
    expect(
      offenders,
      'a ledger sum read without paging returns db-max-rows worth of it and says '
      + 'nothing. Use readAll from @/lib/supabase/read-all with a stable .order():\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('does not opt out of the truncation error', () => {
    // `failOnMax: false` is the documented opt-out for LISTS. On a sum it would
    // restore the exact defect: a prefix returned with error: null.
    for (const { file, fn } of LEDGER_SUMS) {
      const body = bodyOf(readFileSync(file, 'utf8'), fn);
      expect(/failOnMax:\s*false/.test(body), `${file}: ${fn} opts out of the truncation error`).toBe(false);
    }
  });
});
