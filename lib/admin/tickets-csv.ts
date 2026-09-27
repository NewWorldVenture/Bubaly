/**
 * CSV for the support-ticket export (/admin/support-tickets → Export).
 *
 * Subjects and descriptions are written by whoever filed the ticket, so a cell
 * that starts with = + - @ (or a tab/CR) is prefixed with an apostrophe: opened
 * in a spreadsheet, it is text, not a formula a stranger wrote. Audit C1-S9-105.
 */
export const TICKET_CSV_COLUMNS = [
  'ticket_number', 'status', 'priority', 'category', 'subject', 'requester_name',
  'requester_email', 'assigned_agent_name', 'created_at', 'updated_at', 'description',
] as const;

export function ticketCsvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ticketsCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [TICKET_CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(TICKET_CSV_COLUMNS.map((c) => ticketCsvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
