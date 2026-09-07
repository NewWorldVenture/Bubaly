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

// ── Contacts (vCard + CSV) ─────────────────────────────────

/**
 * One contact as it arrives from an export, before it is resolved against the
 * family's own rows. `emails`/`phones` keep the order the source listed them —
 * the first of each becomes `email`/`phone` on the row, the second `phone_alt`.
 */
export type ImportedContact = {
  name: string;
  emails: string[];
  phones: string[];
  organization: string | null;
  notes: string | null;
};

/** Lower-cased, trimmed email — the identity two exports of one person share. */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * A phone reduced to what actually identifies it: its digits, keeping the last
 * ten. Exports disagree about punctuation and country prefix for the same
 * number — "(555) 010-1234", "+1 555-010-1234" and "5550101234" are one phone,
 * and a dedupe that compares raw text imports the same neighbour three times.
 * Fewer than seven digits is not an identity (an extension, a truncated cell),
 * so it normalizes to '' and never matches anything.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D+/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-10);
}

/** Every identity key a contact can be matched on (normalised emails + phones). */
export function contactKeys(contact: Pick<ImportedContact, 'emails' | 'phones'>): string[] {
  const keys: string[] = [];
  for (const e of contact.emails) {
    const n = normalizeEmail(e);
    if (n) keys.push(`email:${n}`);
  }
  for (const p of contact.phones) {
    const n = normalizePhone(p);
    if (n) keys.push(`phone:${n}`);
  }
  return keys;
}

/** Unfold RFC-6350 lines and drop blanks. */
function unfoldLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * A vCard value may be quoted-printable — Outlook and older Android exports
 * still emit it, which turns "Müller" into "M=C3=BCller". Decoding it is the
 * difference between importing a name and importing mojibake.
 */
function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
}

/** Display name from a structured N property: Family;Given;Middle;Prefix;Suffix. */
function nameFromN(value: string): string {
  const [family = '', given = '', middle = ''] = value.split(';').map((p) => p.trim());
  return [given, middle, family].filter(Boolean).join(' ').trim();
}

/**
 * Parse a .vcf document (vCard 2.1 / 3.0 / 4.0) into contacts.
 *
 * Deliberately tolerant: property groups (`item1.EMAIL`), parameters
 * (`TEL;TYPE=CELL`), folded lines and quoted-printable encoding all appear in
 * real exports from Apple Contacts, Google Contacts and Outlook, and a parser
 * that only reads the spec's happy path imports nothing from any of them. A
 * card with no name at all is dropped rather than imported as "Untitled" — a
 * nameless contact is noise the family then has to delete by hand.
 */
export function parseVCard(text: string): ImportedContact[] {
  const out: ImportedContact[] = [];
  let cur: (ImportedContact & { structuredName?: string }) | null = null;

  for (const line of unfoldLines(text)) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      cur = { name: '', emails: [], phones: [], organization: null, notes: null };
      continue;
    }
    if (upper === 'END:VCARD') {
      if (cur) {
        const name = cur.name || cur.structuredName || '';
        if (name) out.push({ name, emails: cur.emails, phones: cur.phones, organization: cur.organization, notes: cur.notes });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const rawName = line.slice(0, colon);
    let value = line.slice(colon + 1).trim();
    const params = rawName.toUpperCase();
    // Strip a property group ("item1.EMAIL") and the parameter list.
    const prop = params.split(';')[0].split('.').pop() ?? '';
    if (params.includes('QUOTED-PRINTABLE')) value = decodeQuotedPrintable(value);
    value = unescapeText(value).trim();
    if (!value) continue;

    switch (prop) {
      case 'FN': cur.name = value; break;
      case 'N': cur.structuredName = nameFromN(value); break;
      case 'EMAIL': if (!cur.emails.includes(value)) cur.emails.push(value); break;
      case 'TEL': if (!cur.phones.includes(value)) cur.phones.push(value); break;
      case 'ORG': cur.organization = value.split(';')[0].trim() || null; break;
      case 'NOTE': cur.notes = value; break;
    }
  }
  return out;
}

/** Header names an export is likely to use for each contact field. */
export const CSV_CONTACT_COLUMNS = {
  name: ['name', 'full name', 'display name', 'contact name'],
  firstName: ['first name', 'given name', 'firstname'],
  lastName: ['last name', 'family name', 'surname', 'lastname'],
  email: ['e-mail address', 'email address', 'email', 'e-mail'],
  phone: ['phone number', 'mobile phone', 'phone', 'mobile', 'cell', 'telephone'],
  phoneAlt: ['home phone', 'work phone', 'other phone', 'phone 2'],
  organization: ['organization', 'company', 'organisation'],
  notes: ['notes', 'note', 'comment'],
} as const;

/**
 * Map a contacts CSV (Google Contacts, Outlook, a spreadsheet someone typed)
 * into contacts. Falls back to first + last name columns when there is no
 * single name column, which is how both Google and Outlook actually export.
 */
export function csvToContacts(table: CsvTable): ImportedContact[] {
  if (table.rows.length === 0) return [];
  const idx = (cands: readonly string[]) => matchColumn(table.headers, [...cands]);
  const firstIdx = idx(CSV_CONTACT_COLUMNS.firstName);
  const lastIdx = idx(CSV_CONTACT_COLUMNS.lastName);
  // `matchColumn` falls back to a substring match, so the candidate "name"
  // happily lands on "First Name" — which imported Google's export as a column
  // of first names with the surnames dropped. A full-name column that turned
  // out to BE the first- or last-name column is not one.
  const namedIdx = idx(CSV_CONTACT_COLUMNS.name);
  const nameIdx = namedIdx === firstIdx || namedIdx === lastIdx ? -1 : namedIdx;
  const emailIdx = idx(CSV_CONTACT_COLUMNS.email);
  const phoneIdx = idx(CSV_CONTACT_COLUMNS.phone);
  const phoneAltIdx = idx(CSV_CONTACT_COLUMNS.phoneAlt);
  const orgIdx = idx(CSV_CONTACT_COLUMNS.organization);
  const notesIdx = idx(CSV_CONTACT_COLUMNS.notes);

  const cell = (row: string[], i: number) => (i === -1 ? '' : (row[i] ?? '').trim());
  const out: ImportedContact[] = [];
  for (const row of table.rows) {
    const name = cell(row, nameIdx)
      || [cell(row, firstIdx), cell(row, lastIdx)].filter(Boolean).join(' ').trim();
    if (!name) continue;
    const emails = cell(row, emailIdx).split(/[;,]/).map((v) => v.trim()).filter(Boolean);
    const phones = [cell(row, phoneIdx), cell(row, phoneAltIdx)]
      .flatMap((v) => v.split(/[;,]/))
      .map((v) => v.trim())
      .filter(Boolean);
    out.push({
      name,
      emails,
      phones,
      organization: cell(row, orgIdx) || null,
      notes: cell(row, notesIdx) || null,
    });
  }
  return out;
}

/**
 * Collapse contacts that are the same person.
 *
 * Two cards match when they share a normalised email or phone; a card with
 * neither can only match on an exact (case-insensitive) name, because merging
 * "Mum" into "Mum" with no other detail is a guess either way and folding two
 * different people together is the worse mistake. The kept card takes the first
 * name seen and the union of the contact details, so nothing an export carried
 * is lost to the dedupe.
 */
export function dedupeContacts(contacts: ImportedContact[]): ImportedContact[] {
  const out: ImportedContact[] = [];
  const byKey = new Map<string, number>();
  const byName = new Map<string, number>();

  for (const contact of contacts) {
    const name = contact.name.trim();
    if (!name) continue;
    const keys = contactKeys(contact);
    let at = -1;
    for (const k of keys) {
      const found = byKey.get(k);
      if (found !== undefined) { at = found; break; }
    }
    if (at === -1 && keys.length === 0) {
      const found = byName.get(name.toLowerCase());
      if (found !== undefined) at = found;
    }
    if (at === -1) {
      at = out.length;
      out.push({ ...contact, name, emails: [...contact.emails], phones: [...contact.phones] });
    } else {
      const target = out[at];
      for (const e of contact.emails) {
        if (!target.emails.some((x) => normalizeEmail(x) === normalizeEmail(e))) target.emails.push(e);
      }
      for (const p of contact.phones) {
        const n = normalizePhone(p);
        if (!target.phones.some((x) => (n ? normalizePhone(x) === n : x.trim() === p.trim()))) target.phones.push(p);
      }
      target.organization = target.organization ?? contact.organization;
      target.notes = target.notes ?? contact.notes;
    }
    for (const k of contactKeys(out[at])) byKey.set(k, at);
    byName.set(out[at].name.toLowerCase(), at);
  }
  return out;
}
