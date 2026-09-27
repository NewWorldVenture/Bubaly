import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSensitiveTable, SENSITIVE_TABLE_NAMES } from '@/lib/ai/context/policy';

// PRIV-001. `tests/context-policy.test.ts` asserts that no AI context slice
// selects from a deny-listed table. It reads the slice FILE, so its search
// space is one file deep — and the policy's own comment says slices reach
// sensitive areas deliberately, through "domain services, which project the one
// narrow column a plan legitimately needs". That projection is the actual
// control, and nothing checked it.
//
// Measured: six of the fourteen slices can reach nine deny-listed tables
// through their imports. Every one is safe today, for one of two reasons:
//
//   - it is projected narrowly before anything reaches the model
//     (medical_profiles -> allergies; documents -> id, for a count;
//     financial_accounts -> a COUNT of overdrawn accounts, never a figure;
//     family_messages -> conversation_id and read_by, never a body), or
//   - the slice never calls the function that reads it.
//
// The second reason is the reason for this guard. An import closure is not a
// call graph: `lib/services/trips/index.ts` is imported for trip listing and
// happens to also export the reader for `vacation_emergency_contacts`. Nothing
// fails if a slice starts calling it. The depth-1 rule stays green, because the
// slice file still names no denied table.
//
// So this pins the PAIRS. A new (slice, sensitive table) reach fails here with
// the file that reads it, and has to be justified by editing this baseline
// rather than by passing silently.

const SLICES_DIR = join('lib', 'ai', 'context', 'slices');

/** `@/x/y` -> the file it resolves to, or null for a package import. */
function resolveLocal(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  const base = spec.slice(2);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type Reach = { slice: string; table: string; file: string };

/** Every deny-listed table read anywhere in a slice's transitive import closure. */
export function sensitiveReach(slice: string, resolver = resolveLocal): { reaches: Reach[]; filesWalked: number } {
  const root = join(SLICES_DIR, slice);
  const seen = new Set([root]);
  const queue = [root];
  const reaches: Reach[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g)) {
      const table = m[1];
      if (isSensitiveTable(table) && !reaches.some((r) => r.table === table && r.file === file)) {
        reaches.push({ slice, table, file });
      }
    }
    for (const imp of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const next = resolver(imp[1]);
      if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return { reaches, filesWalked: seen.size };
}

/**
 * Every reach that exists today, with why it is safe. `projected` means the
 * value is narrowed before it reaches the model; `not-called` means the reader
 * is in the closure but nothing calls it — which is exactly the state this
 * baseline exists to notice a change in.
 */
const BASELINE: Record<string, { table: string; why: 'projected' | 'not-called'; note: string }[]> = {
  'documents.ts': [
    { table: 'documents', why: 'projected', note: 'the slice maps to id/title/category/expiresAt/member/isSecure; lines carry title, category, member, expiry — never contents, never a storage path' },
    { table: 'vacation_documents', why: 'not-called', note: 'exported by the same documents service module; the slice calls listDocuments and expiringBefore only' },
  ],
  'food.ts': [
    { table: 'medical_profiles', why: 'projected', note: "select('member_id, allergies') — the projection the policy comment names explicitly" },
  ],
  'shopping.ts': [
    { table: 'medical_profiles', why: 'projected', note: "select('allergies') — one column, so a grocery list can avoid what somebody reacts to" },
  ],
  'proactive.ts': [
    { table: 'documents', why: 'projected', note: "select('id') for a count of documents expiring within 30 days" },
    { table: 'financial_accounts', why: 'projected', note: "select('id, balance') filtered to overdrawn non-credit accounts, then reduced to `accountsRes.data?.length` — a count reaches the model, never a balance" },
    { table: 'family_messages', why: 'projected', note: "select('conversation_id, read_by') — no message body" },
  ],
  'travel.ts': [
    { table: 'vacation_documents', why: 'not-called', note: 'exported by the trips service module the slice imports for trip listing' },
    { table: 'vacation_emergency_contacts', why: 'not-called', note: 'same module; the slice mentions no contact field at all' },
  ],
};

const slices = readdirSync(SLICES_DIR).filter((f) => f.endsWith('.ts'));
const measured = slices.map((s) => ({ slice: s, ...sensitiveReach(s) }));

describe('a sensitive table is one call away (PRIV-001)', () => {
  it('walks past the slice file', () => {
    // A closure walker that resolved nothing would report zero reaches and this
    // whole guard would be an assertion about an empty set.
    for (const m of measured) expect(m.filesWalked, m.slice).toBeGreaterThan(1);
    expect(SENSITIVE_TABLE_NAMES.size).toBeGreaterThanOrEqual(60);
  });

  it('every slice reaches exactly the sensitive tables the baseline records', () => {
    const drift: string[] = [];
    for (const { slice, reaches } of measured) {
      const expected = new Set((BASELINE[slice] ?? []).map((b) => b.table));
      for (const r of reaches) {
        if (!expected.has(r.table)) drift.push(`NEW: ${slice} can now reach ${r.table} via ${r.file}`);
      }
      for (const table of expected) {
        if (!reaches.some((r) => r.table === table)) drift.push(`GONE: ${slice} no longer reaches ${table} — remove it from the baseline`);
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('every baseline entry says why it is safe', () => {
    for (const [slice, entries] of Object.entries(BASELINE)) {
      expect(slices, `${slice} is in the baseline but not on disk`).toContain(slice);
      for (const e of entries) {
        expect(isSensitiveTable(e.table), `${slice}/${e.table} is not on the deny list`).toBe(true);
        expect(e.note.length, `${slice}/${e.table}`).toBeGreaterThan(20);
      }
    }
  });

  it('the count that stands in for a balance is still a count', () => {
    // The one reach where a raw figure would be the leak. If this line starts
    // carrying `balance` instead of a length, the projection note above is false.
    const server = readFileSync('lib/operating-index/server.ts', 'utf8');
    expect(server).toMatch(/const negativeBalances = accountsRes\.data\?\.length \?\? 0;/);
  });

  it('the documents slice still emits titles rather than rows', () => {
    const slice = readFileSync(join(SLICES_DIR, 'documents.ts'), 'utf8');
    // The mapping is the control; a spread would hand the whole service row on.
    expect(slice).not.toMatch(/\.\.\.d[,}\s]/);
    // The comment is line-wrapped in the source, so match across the wrap.
    expect(slice.replace(/\s*\n\s*\/\/\s*/g, ' ')).toContain('never contents, never a storage path');
  });

  it('notices a new reach', () => {
    // Fed a resolver that adds one module, the walker must report what that
    // module reads. Without this the drift test is an absence.
    const withExtra = (spec: string): string | null =>
      spec === '@/lib/ai/context/policy' ? 'lib/ai/context/policy.ts' : resolveLocal(spec);
    // policy.ts names sensitive tables in `table: '...'` form, not `.from(...)`,
    // so use a module that genuinely reads one: the operating index.
    const injected = (spec: string): string | null =>
      spec === '@/lib/services/types' ? 'lib/operating-index/server.ts' : resolveLocal(spec);
    const before = sensitiveReach('tasks.ts');
    const after = sensitiveReach('tasks.ts', injected);
    expect(before.reaches).toEqual([]);
    expect(after.reaches.map((r) => r.table).sort()).toEqual(['documents', 'family_messages', 'financial_accounts']);
    expect(withExtra('@/lib/ai/context/policy')).toBe('lib/ai/context/policy.ts');
  });
});
