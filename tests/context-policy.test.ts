// The sensitive-data policy (§4, §27, §43), tested two ways:
//   - statically: no file under lib/ai/context/slices selects from a table on
//     the deny-list. Slices go through domain services, which project the one
//     narrow column (allergies, a document title) a plan legitimately needs.
//   - behaviourally: the role rules — money and documents are manager-only,
//     and a child gets neither whatever the intent claims to require.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySlicePolicy, canViewSlice, isSensitiveTable, SENSITIVE_TABLE_NAMES, SENSITIVE_TABLES, SLICE_ACCESS, viewerFor,
} from '@/lib/ai/context/policy';
import { SLICE_NAMES } from '@/lib/ai/context/intents';

const SLICES_DIR = join(process.cwd(), 'lib', 'ai', 'context', 'slices');

/** Every `.from('table')` in a source file. */
function selectedTables(source: string): string[] {
  return [...source.matchAll(/\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g)].map((m) => m[1]);
}

describe('static ratchet: slices never read a denied table', () => {
  const files = readdirSync(SLICES_DIR).filter((f) => f.endsWith('.ts'));

  it('has one slice file per slice name', () => {
    expect(files.map((f) => f.replace(/\.ts$/, '')).sort()).toEqual([...SLICE_NAMES].sort());
  });

  for (const file of files) {
    it(`${file} selects only from permitted tables`, () => {
      const source = readFileSync(join(SLICES_DIR, file), 'utf8');
      const denied = selectedTables(source).filter(isSensitiveTable);
      expect(denied).toEqual([]);
      // Row text must be fenced or sanitised on its way into a line.
      expect(source).toMatch(/fenceUntrusted|sanitizeUntrusted/);
    });
  }

  it('names the areas the spec calls out explicitly', () => {
    for (const table of [
      'family_credentials', 'documents', 'vacation_documents', 'tax_documents', 'household_info',
      'medical_profiles', 'medications', 'medication_schedules', 'health_visits', 'immunizations',
      'family_emergency_contacts', 'family_emergency_plans', 'member_locations', 'safety_check_ins', 'driving_trips',
      'financial_accounts', 'wallet_cards', 'stripe_issuing_cards',
    ]) {
      expect(SENSITIVE_TABLE_NAMES.has(table)).toBe(true);
    }
    // Every entry carries a reason a reviewer can read.
    for (const entry of SENSITIVE_TABLES) expect(entry.reason.length).toBeGreaterThan(3);
    expect(new Set(SENSITIVE_TABLES.map((t) => t.table)).size).toBe(SENSITIVE_TABLES.length);
  });
});

describe('role policy', () => {
  it('money and documents are the manager-only slices', () => {
    const managerOnly = SLICE_NAMES.filter((s) => SLICE_ACCESS[s].managerOnly);
    expect(managerOnly.sort()).toEqual(['documents', 'money']);
  });

  it('a child or teen is refused money and documents regardless of the requested list', () => {
    for (const role of ['child', 'teen', 'guest', 'caregiver'] as const) {
      const viewer = viewerFor({ role, memberId: 'm' });
      expect(viewer.canManage).toBe(false);
      expect(canViewSlice('money', viewer).allowed).toBe(false);
      expect(canViewSlice('documents', viewer).allowed).toBe(false);
      expect(canViewSlice('schedule', viewer).allowed).toBe(true);
      const { allowed, omitted } = applySlicePolicy(['people', 'money', 'documents', 'schedule', 'money'], viewer);
      expect(allowed).toEqual(['people', 'schedule']);
      expect(omitted).toEqual(['money', 'documents']);
    }
  });

  it('parents, adults and the system see everything', () => {
    for (const role of ['parent', 'adult', 'system'] as const) {
      const viewer = viewerFor({ role, memberId: role === 'system' ? null : 'm' });
      expect(viewer.canManage).toBe(true);
      const { allowed, omitted } = applySlicePolicy([...SLICE_NAMES], viewer);
      expect(allowed).toEqual([...SLICE_NAMES]);
      expect(omitted).toEqual([]);
    }
  });

  it('keeps the requested order (the trim priority) and drops duplicates', () => {
    const viewer = viewerFor({ role: 'parent', memberId: 'm' });
    expect(applySlicePolicy(['food', 'people', 'food', 'money'], viewer).allowed).toEqual(['food', 'people', 'money']);
  });
});
