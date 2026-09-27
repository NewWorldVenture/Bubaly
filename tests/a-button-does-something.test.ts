import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ticketCsvCell, ticketsCsv, TICKET_CSV_COLUMNS } from '@/lib/admin/tickets-csv';

// Audit C1-S9-105 — the page audit found buttons that did nothing when pressed:
// "Invite Admin" (/admin/admins), "Export" and "New Ticket"
// (/admin/support-tickets), the ticket menu's "Assign agent", "Ask AI" on
// /dashboard/sports and /dashboard/school, and a "more options" on every row of
// both of those tables. Each looked like a control and had no handler.
//
// A button does something when it has an onClick, a type (submit/reset/
// button with a handler elsewhere is still caught by onClick), a formAction,
// asChild, or sits inside a <form> (a native button submits it) or a <Link>
// (the link navigates). Anything else is a control that lies.

function tagsIn(src: string, from: number): { attrs: string; end: number } {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return { attrs: src.slice(from, i), end: i };
  }
  return { attrs: src.slice(from), end: src.length };
}

const open = (src: string, at: number, tag: string) =>
  (src.slice(0, at).match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length
  - (src.slice(0, at).match(new RegExp(`</${tag}>`, 'g')) ?? []).length;

export function deadButtons(raw: string): string[] {
  // Comments mention <button> in prose; blank them, keeping offsets and lines.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
  const out: string[] = [];
  for (const m of src.matchAll(/<(Button|button)(?=[\s>])/g)) {
    const { attrs } = tagsIn(src, (m.index ?? 0) + m[0].length);
    if (/\bonClick=|\btype=|\bformAction=|\basChild\b|\{\.\.\./.test(attrs)) continue;
    if (open(src, m.index ?? 0, 'form') > 0 || open(src, m.index ?? 0, 'Link') > 0 || open(src, m.index ?? 0, 'a') > 0) continue;
    out.push(`line ${src.slice(0, m.index).split('\n').length}: <${m[1]}${attrs.replace(/\s+/g, ' ').slice(0, 80)}>`);
  }
  return out;
}

describe('a button does something (C1-S9-105)', () => {
  it('no page or component renders a button with no action', () => {
    const files = execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' }).split('\n').filter(Boolean);
    const offenders = files.flatMap((f) => deadButtons(readFileSync(f, 'utf8')).map((d) => `${f} ${d}`));
    expect(offenders).toEqual([]);
  });

  it('the detector is not vacuous: it catches the buttons this finding was about', () => {
    expect(deadButtons('<div><button aria-label="More"><Icon /></button></div>')).toHaveLength(1);
    expect(deadButtons('<Button className="mt-4 w-full">{tr(\'sports.askAi\')}</Button>')).toHaveLength(1);
    expect(deadButtons('<button onClick={() => go(a > b)}>x</button>')).toEqual([]);
    expect(deadButtons('<form action={f}><button>Send</button></form>')).toEqual([]);
    expect(deadButtons('<Link href="/x"><Button>Go</Button></Link>')).toEqual([]);
  });
});

describe('the support-ticket export', () => {
  it('keeps a stranger\'s formula as text', () => {
    expect(ticketCsvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(ticketCsvCell('+1 555')).toBe("'+1 555");
    expect(ticketCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(ticketCsvCell('plain')).toBe('plain');
    expect(ticketCsvCell(null)).toBe('');
  });

  it('writes a header and one line per ticket', () => {
    const csv = ticketsCsv([{ ticket_number: 'TKT-1', subject: 'Hi, there' }]);
    const [head, row] = csv.trim().split('\n');
    expect(head).toBe(TICKET_CSV_COLUMNS.join(','));
    expect(row.startsWith('TKT-1,')).toBe(true);
    expect(row).toContain('"Hi, there"');
  });

  it('is linked from the page it serves', () => {
    expect(readFileSync('app/(app)/admin/support-tickets/page.tsx', 'utf8')).toContain('href="/api/admin/support-tickets/export"');
  });
});
