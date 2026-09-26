import { describe, expect, it } from 'vitest';
import { localDayKeyOf } from '@/lib/time/local-day';
import { txnTypeLabel, signedAmountCents, filterTxns, groupByDay, netCents, toStatementCsv, statementFilename, type ActivityTxn } from '@/lib/wallet/activity';

const t = (over: Partial<ActivityTxn>): ActivityTxn => ({
  id: Math.random().toString(36).slice(2), child_wallet_id: 'c1', type: 'parent_top_up', status: 'completed',
  direction: 'credit', amount_cents: 1000, description: null, created_at: '2026-06-24T10:00:00Z', ...over,
});

describe('txnTypeLabel', () => {
  it('maps known + falls back', () => {
    expect(txnTypeLabel('chore_reward')).toBe('Chore reward');
    expect(txnTypeLabel('gift_received')).toBe('Gift');
    expect(txnTypeLabel('mystery_type')).toBe('mystery type');
  });
});

describe('signedAmountCents', () => {
  it('credit +, debit -', () => {
    expect(signedAmountCents({ direction: 'credit', amount_cents: 500 })).toBe(500);
    expect(signedAmountCents({ direction: 'debit', amount_cents: 500 })).toBe(-500);
  });
});

describe('filterTxns', () => {
  const rows = [t({ child_wallet_id: 'c1', type: 'allowance', direction: 'credit' }), t({ child_wallet_id: 'c2', type: 'goal_transfer', direction: 'debit' })];
  it('filters by child/type/direction', () => {
    expect(filterTxns(rows, { childWalletId: 'c2' })).toHaveLength(1);
    expect(filterTxns(rows, { type: 'allowance' })[0].child_wallet_id).toBe('c1');
    expect(filterTxns(rows, { direction: 'debit' })[0].child_wallet_id).toBe('c2');
    expect(filterTxns(rows, {})).toHaveLength(2);
  });
});

describe('groupByDay', () => {
  it('groups newest day first', () => {
    const later = '2026-06-24T09:00:00Z', alsoLater = '2026-06-24T08:00:00Z', earlier = '2026-06-20T09:00:00Z';
    const g = groupByDay([t({ created_at: earlier }), t({ created_at: later }), t({ created_at: alsoLater })]);
    // Derived rather than written as '2026-06-24' / '2026-06-20'. The grouping key
    // is the READER's day, and at UTC-12 these two instants fall on the 23rd and
    // the 19th — so the literals were a statement about the host, which passed at
    // UTC and at four other zones and failed at the sixth.
    expect(g.map((x) => x.date)).toEqual([localDayKeyOf(later), localDayKeyOf(earlier)]);
    // The ordering and the bucketing are what this case is really about, and they
    // hold in every zone: two transactions eight and nine hours into the same UTC
    // day stay together, whichever local day that is.
    expect(localDayKeyOf(later)).toBe(localDayKeyOf(alsoLater));
    expect(g).toHaveLength(2);
    expect(g[0].txns).toHaveLength(2);
  });
});

describe('netCents', () => {
  it('credits minus debits, completed only', () => {
    expect(netCents([t({ amount_cents: 1000, direction: 'credit' }), t({ amount_cents: 300, direction: 'debit' }), t({ amount_cents: 999, status: 'pending' })])).toBe(700);
  });
});

describe('toStatementCsv', () => {
  const rows = [
    // newest-first
    { ...t({ id: 'n', amount_cents: 300, direction: 'debit', type: 'card_spend', description: 'Snacks', created_at: '2026-06-25T14:30:00Z' }), childName: 'Mia' },
    { ...t({ id: 'o', amount_cents: 1000, direction: 'credit', type: 'allowance', description: null, created_at: '2026-06-24T09:00:00Z' }), childName: 'Mia' },
  ];

  it('emits a header + one row per txn, CRLF-joined', () => {
    const lines = toStatementCsv(rows).split('\r\n');
    expect(lines[0]).toBe('Date,Time,Type,Description,Child,Direction,Amount,Status,Balance');
    expect(lines).toHaveLength(3);
  });

  it('runs the balance oldest→newest so the newest row shows the current total', () => {
    const lines = toStatementCsv(rows).split('\r\n');
    // The date and clock are the READER's, so they are derived here rather than
    // written as literals. This case used to read '2026-06-25,14:30:00' — the
    // GREENWICH clock — which passed under TZ=UTC and failed under CI's second
    // run at TZ=America/Los_Angeles once the export started following the reader.
    // The literal was encoding the defect, not the contract.
    const stamp = (iso: string) => {
      const d = new Date(iso);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${localDayKeyOf(iso)},${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    // oldest (+10.00) → balance 10.00; newest (−3.00) → balance 7.00
    expect(lines[1]).toBe(`${stamp('2026-06-25T14:30:00Z')},Card spend,Snacks,Mia,out,-3.00,completed,7.00`);
    expect(lines[2]).toBe(`${stamp('2026-06-24T09:00:00Z')},Allowance,,Mia,in,10.00,completed,10.00`);
    // And the balances are the point of this case, asserted independently of any
    // clock so a timezone change can never quietly take them with it.
    expect(lines[1].endsWith(',7.00')).toBe(true);
    expect(lines[2].endsWith(',10.00')).toBe(true);
  });

  it('excludes non-completed rows from the running balance', () => {
    const withPending = [
      { ...t({ id: 'p', amount_cents: 5000, direction: 'credit', status: 'pending', created_at: '2026-06-26T10:00:00Z' }), childName: null },
      ...rows,
    ];
    const lines = toStatementCsv(withPending).split('\r\n');
    // pending row keeps the prior balance (7.00), not 57.00
    expect(lines[1].endsWith(',pending,7.00')).toBe(true);
  });

  it('escapes commas and quotes per RFC 4180', () => {
    const csv = toStatementCsv([{ ...t({ id: 'x', description: 'Lunch, "the good" one' }), childName: null }]);
    expect(csv.split('\r\n')[1]).toContain('"Lunch, ""the good"" one"');
  });
});

describe('statementFilename', () => {
  it('is date-stamped', () => {
    expect(statementFilename(new Date('2026-07-03T12:00:00Z'))).toBe('bubaly-wallet-statement-2026-07-03.csv');
  });
});

// A statement is grouped by the day the READER had, not the day Greenwich had.
//
// `groupByDay` and `toStatementCsv` both took `.slice(0, 10)` off the ISO
// `created_at`, which is the date at Greenwich. Every caller of them is a CLIENT
// component — components/wallet/activity-view.tsx and child-detail-view.tsx —
// where the runtime IS the reader, so this was not a missing family timezone: it
// was the wrong day outright for anybody not living at offset zero.
//
// These assert a RELATIONSHIP rather than a literal, and that is deliberate. The
// suite runs twice in CI, once under TZ=UTC and once under
// TZ=America/Los_Angeles, so any case that hard-codes "2026-06-20" is asserting
// something about the host rather than about the code — which is the very mistake
// tests/a-server-rendered-time-is-the-familys-time.test.ts had to be repaired for.
// The contract "the grouping key is the local day key" is true in every zone.
describe('a wallet statement follows the reader\u2019s day', () => {
  const at = (iso: string) => ({
    id: iso, created_at: iso, direction: 'credit' as const, amount_cents: 100,
    type: 'allowance', description: 'Allowance', balance_after_cents: 100,
    status: 'completed', child_name: 'Sam', child_wallet_id: 'c1',
  });

  // Built from LOCAL parts, so each is that wall-clock time wherever this runs.
  const lateEvening = new Date(2026, 5, 20, 23, 30, 0);   // 23:30 on 20 June, local
  const earlyMorning = new Date(2026, 5, 21, 0, 30, 0);   // 00:30 on 21 June, local

  it.each([['a late evening', lateEvening], ['an early morning', earlyMorning]])(
    'groups %s transaction under the day the reader is having', (_label, when) => {
      const iso = when.toISOString();
      expect(groupByDay([at(iso)]).map((g) => g.date)).toEqual([localDayKeyOf(iso)]);
    });

  it('puts the CSV date and clock on the reader\u2019s wall too', () => {
    const iso = lateEvening.toISOString();
    const csv = toStatementCsv([at(iso)] as never);
    expect(csv).toContain(localDayKeyOf(iso));
    expect(csv).toContain('23:30:00');
  });

  // Non-vacuity floor, and it is CONDITIONAL on purpose. West of Greenwich a
  // local late evening is already the next UTC day, and east of it a local early
  // morning is still the previous one — so on any host with an offset, at least
  // one of these two differs from the Greenwich slice. On a UTC host neither
  // does, and that is not a gap: at offset zero the two answers genuinely
  // coincide, and asserting a difference there would be asserting a falsehood.
  it('and that is a different day from Greenwich\u2019s, wherever this host has an offset', () => {
    const offsetMinutes = -lateEvening.getTimezoneOffset();
    const pairs = [lateEvening, earlyMorning].map((d) => {
      const iso = d.toISOString();
      return { local: localDayKeyOf(iso), greenwich: iso.slice(0, 10) };
    });
    if (offsetMinutes === 0) {
      expect(pairs.every((p) => p.local === p.greenwich),
        'at offset zero the reader IS Greenwich, so these must agree').toBe(true);
      return;
    }
    expect(pairs.some((p) => p.local !== p.greenwich),
      `offset ${offsetMinutes} min, yet no local/Greenwich pair differs: ${JSON.stringify(pairs)}`).toBe(true);
    // And the grouping follows the local one, not the Greenwich one.
    for (const d of [lateEvening, earlyMorning]) {
      const iso = d.toISOString();
      expect(groupByDay([at(iso)])[0].date).toBe(localDayKeyOf(iso));
    }
  });
});
