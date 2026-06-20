// lib/migrate/parse.ts
// Dependency-free, isomorphic parsers for the competitor-migration importer.
// Pure functions (no I/O) so they run in the browser during preview AND are
// unit-testable. Handle the universal export formats every competitor offers:
// ICS calendars (Cozi, FamilyWall, Google, Apple, Outlook) and CSV lists.

export type ImportedEvent = {
  title: string;
  startsAt: string;       // ISO 8601
  endsAt: string | null;  // ISO 8601 or null
  allDay: boolean;
  location: string | null;
  description: string | null;
};

// ── ICS ────────────────────────────────────────────────────

/** Unescape RFC-5545 TEXT values (\n \, \; \\). */
function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** Parse an ICS DATE or DATE-TIME (optionally with VALUE=DATE / TZID params). */
function parseIcsDate(raw: string, isDateOnly: boolean): { iso: string; allDay: boolean } | null {
  const v = raw.trim();
  // Date-only: YYYYMMDD
  if (isDateOnly || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) return null;
    return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, allDay: true };
  }
  // Date-time: YYYYMMDDTHHMMSS(Z)?
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // Treat both UTC ("Z") and naive/TZID datetimes as UTC for a deterministic
  // result (naive values are approximated; documented in the UI).
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), allDay: false };
}

/** Parse an .ics document into events. Robust to line-folding and CRLF. */
export function parseICS(text: string): ImportedEvent[] {
  // Unfold: a CRLF/LF followed by a space or tab continues the previous line.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');

  const events: ImportedEvent[] = [];
  let cur: Partial<ImportedEvent> & { _dtStartDateOnly?: boolean } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (trimmed === 'END:VEVENT') {
      if (cur && cur.title && cur.startsAt) {
        events.push({
          title: cur.title, startsAt: cur.startsAt, endsAt: cur.endsAt ?? null,
          allDay: cur.allDay ?? false, location: cur.location ?? null, description: cur.description ?? null,
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const rawName = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const name = rawName.split(';')[0].toUpperCase();
    const params = rawName.toUpperCase();
    const isDateOnly = params.includes('VALUE=DATE');

    switch (name) {
      case 'SUMMARY': cur.title = unescapeText(value) || 'Untitled event'; break;
      case 'LOCATION': cur.location = unescapeText(value) || null; break;
      case 'DESCRIPTION': cur.description = unescapeText(value) || null; break;
      case 'DTSTART': {
        const p = parseIcsDate(value, isDateOnly);
        if (p) { cur.startsAt = p.iso; cur.allDay = p.allDay; }
        break;
      }
      case 'DTEND': {
        const p = parseIcsDate(value, isDateOnly);
        if (p) cur.endsAt = p.iso;
        break;
      }
    }
  }
  return events;
}

// ── CSV ────────────────────────────────────────────────────

export type CsvTable = { headers: string[]; rows: string[][] };

/** RFC-4180-ish CSV parser: handles quoted fields, embedded commas/quotes/newlines. */
export function parseCSV(text: string): CsvTable {
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n') {
      record.push(field); records.push(record); field = ''; record = [];
    } else field += c;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  return { headers, rows: nonEmpty.slice(1) };
}

/** Find the first matching column index for any of the candidate header names. */
export function matchColumn(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i !== -1) return i;
  }
  // fuzzy contains
  for (let i = 0; i < lower.length; i++) {
    if (candidates.some((c) => lower[i].includes(c.toLowerCase()))) return i;
  }
  return -1;
}

export type ImportedItem = { name: string; extra?: string | null };

/** Map a CSV table to simple {name, extra} items using likely column names. */
export function csvToItems(table: CsvTable, nameCols: string[], extraCols: string[] = []): ImportedItem[] {
  if (table.rows.length === 0) return [];
  let nameIdx = matchColumn(table.headers, nameCols);
  if (nameIdx === -1) nameIdx = 0; // fall back to first column
  const extraIdx = extraCols.length ? matchColumn(table.headers, extraCols) : -1;
  const out: ImportedItem[] = [];
  for (const row of table.rows) {
    const name = (row[nameIdx] ?? '').trim();
    if (!name) continue;
    out.push({ name, extra: extraIdx !== -1 ? (row[extraIdx] ?? '').trim() || null : null });
  }
  return out;
}
