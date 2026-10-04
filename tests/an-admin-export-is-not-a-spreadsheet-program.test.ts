import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { csvCell, csvDocument, spreadsheetText } from '@/lib/csv/spreadsheet-cell';

/**
 * The admin exports wrote user-typed names, emails and family names into
 * quoted cells that a spreadsheet still runs as a formula when they begin with
 * = + - @, or when a `;` inside them starts a new cell for Excel in the
 * semicolon locales. The mounted proof is tests/e2e/admin-csv-export-formulas
 * .spec.ts; these pin the cell writer and that both exports use it.
 */

describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("https://example.test")', `"'=HYPERLINK(""https://example.test"")"`],
    ['+1+1@example.test', `"'+1+1@example.test"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1:A9)', `"'@SUM(A1:A9)"`],
    ['Smith;=1+1', `"Smith;'=1+1"`],
    ['first\n=1+1', `"first\n'=1+1"`],
    ['  =1+1', `"'  =1+1"`],
    ['\u00a0=1+1', `"'\u00a0=1+1"`],
    ['x;\t=1', `"x;\t'=1"`],
    ['\tTAB', `"'\tTAB"`],
  ])('writes %j as text', (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });

  it('leaves ordinary text, and = + - @ in the middle of it, alone', () => {
    expect(csvCell('Ada Lovelace')).toBe('"Ada Lovelace"');
    expect(csvCell('a = b + c - d @ e; f')).toBe('"a = b + c - d @ e; f"');
  });

  it('writes a number as a number — a negative count is not a formula', () => {
    expect(csvCell(-1024)).toBe('"-1024"');
    expect(csvCell(0)).toBe('"0"');
  });

  it('writes nothing for a missing value, and doubles quotes as before', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('csvDocument', () => {
  it('one line per row, header first, every cell through csvCell', () => {
    expect(csvDocument([['Name', 'Size'], ['=1', -3]])).toBe('"Name","Size"\n"\'=1","-3"');
  });
});

describe('spreadsheetText', () => {
  it('is the guard the cells use', () => {
    expect(spreadsheetText('=1')).toBe("'=1");
    expect(spreadsheetText('fine')).toBe('fine');
  });
});

describe('the admin exports write through it', () => {
  it.each(['components/admin/users-toolbar.tsx', 'components/admin/reports-toolbar.tsx'])('%s', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain("import { csvDocument } from '@/lib/csv/spreadsheet-cell';");
    expect(source).toContain('csvDocument([header, ...');
    // No hand-rolled quoting left beside it.
    expect(source).not.toContain(`replace(/"/g, '""')`);
  });
});
