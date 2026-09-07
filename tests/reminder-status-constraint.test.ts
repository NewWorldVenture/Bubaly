// Four one-tap buttons that could never have worked.
//
// `family_reminders` (0014) constrains two columns:
//
//   status   check (status in ('active','snoozed','completed','dismissed'))
//   priority check (priority in ('low','medium','high','urgent'))
//
// Four call sites wrote `status: 'pending'` and, on their non-urgent branch,
// `priority: 'normal'`. Neither value is in either set, so Postgres rejected the
// whole row with 23514 and NOTHING was written — the family got an error toast
// from Front Desk, the Inbox, an Autopilot approval and Paperwork materialisation
// every single time. Proven against a real Postgres 16 before the fix, not
// inferred from reading the SQL.
//
// This file is the guard that would have caught it. It reads the allowed values
// out of the migration rather than restating them, so widening the constraint
// widens the test with it and a typo in either place fails loudly.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = 'supabase/migrations/0014_core_platform.sql';

/** The values a `check (<column> in (...))` on family_reminders actually permits. */
function allowedValues(column: string): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  // The family_reminders block only — other tables in this file constrain the
  // same column names with different sets.
  const table = sql.slice(sql.indexOf('create table if not exists public.family_reminders'));
  const block = table.slice(0, table.indexOf(');'));
  const match = new RegExp(`${column}\\s+text[^\\n]*check \\(${column} in \\(([^)]*)\\)\\)`).exec(block);
  if (!match) throw new Error(`no check constraint found for family_reminders.${column}`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.name === 'node_modules') return [];
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Comments stripped, so a comment quoting the old bad value is not a hit. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}

/**
 * Every literal `<column>: '<value>'` inside a `family_reminders` write.
 *
 * Scoped to the 400 characters after the table name so a `status:` belonging to
 * some other insert in the same file is not attributed here.
 */
function literalsWrittenTo(column: string): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = [];
  for (const dir of ['app', 'components', 'lib']) {
    for (const file of sourceFiles(dir)) {
      const src = code(file);
      for (const write of src.matchAll(/\.from\(\s*['"]family_reminders['"]\s*\)[\s\S]{0,400}/g)) {
        for (const hit of write[0].matchAll(new RegExp(`\\b${column}:\\s*'([^']+)'`, 'g'))) {
          found.push({ file, value: hit[1]! });
        }
      }
    }
  }
  return found;
}

describe('what the app writes to family_reminders is what the column allows', () => {
  it('reads a real constraint out of the migration', () => {
    // If this ever comes back empty the two tests below pass vacuously.
    expect(allowedValues('status')).toEqual(['active', 'snoozed', 'completed', 'dismissed']);
    expect(allowedValues('priority')).toEqual(['low', 'medium', 'high', 'urgent']);
  });

  it.each(['status', 'priority'])('writes no %s the CHECK would reject', (column) => {
    const allowed = allowedValues(column);
    const illegal = literalsWrittenTo(column).filter((w) => !allowed.includes(w.value));
    expect(
      illegal,
      `These writes are rejected by family_reminders_${column}_check (allowed: ${allowed.join(', ')}):\n` +
        illegal.map((w) => `  ${w.file} → ${column}: '${w.value}'`).join('\n'),
    ).toEqual([]);
  });
});

describe('the service is the reason the assistant’s reminders always worked', () => {
  it('writes a status the constraint allows, and maps an unknown priority to a legal one', () => {
    const src = readFileSync('lib/services/reminders/index.ts', 'utf8');
    // The literal the service inserts.
    const status = /status: '([^']+)'/.exec(src)?.[1];
    expect(allowedValues('status')).toContain(status);
    // And it never forwards an unrecognised priority — the guard that turns a
    // caller's 'normal' into the column default instead of a rejected row.
    expect(src).toMatch(/PRIORITIES\.includes\(input\.priority\)/);
  });
});
