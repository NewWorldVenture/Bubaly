import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditMigrationVersions,
  KNOWN_DUPLICATE_MIGRATIONS,
} from '../scripts/audit-migration-versions.mjs';

describe('Supabase migration filename safety', () => {
  const audit = auditMigrationVersions();

  it('keeps the known historical collision set explicit', () => {
    expect(audit.unexpectedDuplicates).toEqual([]);
    expect(Object.fromEntries(audit.duplicates.map(({ version, names }) => [version, names])))
      .toEqual(KNOWN_DUPLICATE_MIGRATIONS);
  });

  // 0275 is the newest file, so the next free number is 0276. The gap this
  // leaves is deliberate and is not the collision this suite exists to catch:
  // 0270 is reserved by the travel-confirmations branch and 0274 by the
  // finance-receipts branch, both of which are held behind an unproven
  // production migration ledger. Taking a reserved number to close the gap
  // would hand whichever of them merges first a real collision; the audit
  // takes max+1, so a hole costs nothing.
  it('points new migrations at the next unused version', () => {
    expect(audit.nextVersion).toBe('0276');
  });

  it('flags a newly introduced collision instead of silently accepting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bubaly-migrations-'));
    try {
      writeFileSync(join(directory, '0194_first.sql'), 'select 1;');
      writeFileSync(join(directory, '0194_second.sql'), 'select 1;');
      expect(auditMigrationVersions(directory).unexpectedDuplicates).toEqual([
        { version: '0194', names: ['0194_first.sql', '0194_second.sql'] },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
