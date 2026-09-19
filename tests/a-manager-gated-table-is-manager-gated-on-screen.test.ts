// The health hub writes straight from the browser. There is no server action
// between `components/modules/*-module.tsx` and PostgREST for medications,
// immunizations, visits, rewards or trip items — the user's own JWT carries the
// write, so RLS is the entire authorization model and the UI is the only other
// thing that can decline.
//
// 0309 gated `medications` and `medication_schedules` with restrictive manager
// guards because `medications-module.tsx` declared `canEdit = isManager(role)`
// and the database did not back it: "a hidden button is not a boundary."
// 0326 found the other end of the same class — `immunizations` and
// `health_visits` had NEITHER. No role check in the module, no manager guard in
// the database, and both rendered on /dashboard/medical directly beneath
// MedicalRecordsModule, whose tables were manager-only all along.
//
// So the two halves keep drifting apart in both directions, and each direction
// has its own failure:
//   * guard in the DB, none on screen → the child sees Edit and Delete, taps
//     them, and gets a raw PostgREST refusal (the C2-B "permission denied for
//     table …" class);
//   * gate on screen, none in the DB → the button is hidden and the write still
//     works from any HTTP client.
//
// This asserts the pairing rather than either half: whatever table the
// migrations decide is manager-only, the client that writes it from the browser
// must say so too. It generalises past the two tables 0326 fixed — the next
// module to write a guarded table is caught on the day it is added.
//
// The DB half is asserted separately and for real, against a replayed schema:
// docs/audit/health-record-boundary-check.sql and
// docs/audit/medication-record-boundary-check.sql. Audit C1-S8-03.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// Walked from disk, not from `git ls-files`: the first draft of this guard used
// git and silently skipped the migration that had just been written and not yet
// staged — reporting the tables it was added to protect as ungated. A scanner
// whose input depends on the index answers a different question than the one
// asked of it.
function walk(...dirs: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  for (const d of dirs) visit(d);
  return out;
}

/** Tables any migration puts behind a restrictive `*_manager_*_guard`. */
function managerGatedTables(): string[] {
  const found = new Set<string>();
  for (const rel of walk('supabase/migrations')) {
    if (!rel.endsWith('.sql')) continue;
    const sql = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of sql.matchAll(
      /create\s+policy\s+[a-z_]+_manager_(?:insert|update|delete)_guard\s+on\s+public\.([a-z_]+)/gi,
    )) found.add(m[1]);
  }
  return [...found].sort();
}

/** Client components that write `table` directly through the browser client. */
function clientWritersOf(table: string): string[] {
  const write = new RegExp(`from\\(['"\`]${table}['"\`]\\)\\s*\\.\\s*(insert|update|delete|upsert)\\b`);
  return walk('components', 'app').filter((rel) => {
    if (!rel.endsWith('.tsx')) return false;
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    return src.startsWith("'use client'") && write.test(src);
  });
}

describe('a manager-gated table is manager-gated on screen', () => {
  const tables = managerGatedTables();

  it('finds the guarded tables at all', () => {
    // A scan that quietly matched nothing would pass forever (C4-S5-01's class).
    expect(tables.length).toBeGreaterThanOrEqual(6);
    expect(tables).toContain('medications');
    expect(tables).toContain('immunizations');
    expect(tables).toContain('health_visits');
  });

  it('finds the browser writers it is about', () => {
    expect(clientWritersOf('immunizations')).toContain('components/modules/immunizations-module.tsx');
    expect(clientWritersOf('health_visits')).toContain('components/modules/health-visits-module.tsx');
    // And does not match a component that only READS the table.
    expect(clientWritersOf('immunizations')).not.toContain('components/medical/print-sheet.tsx');
  });

  it('every browser writer of a guarded table declares isManager', () => {
    const unguarded: string[] = [];
    for (const table of tables) {
      for (const rel of clientWritersOf(table)) {
        const src = readFileSync(path.join(ROOT, rel), 'utf8');
        if (!/\bisManager\s*\(/.test(src)) unguarded.push(`${rel} writes ${table}`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});
