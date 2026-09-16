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

  // The 17 historical collisions are gone — every group was renamed to a
  // unique version preserving apply order. KNOWN_DUPLICATE_MIGRATIONS is now
  // empty and must STAY empty: it is the escape hatch that let duplicates
  // accumulate, and re-populating it to quiet a red audit is how they came
  // back the first time.
  it('has no duplicate versions at all, and no escape hatch left open', () => {
    expect(audit.unexpectedDuplicates).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(KNOWN_DUPLICATE_MIGRATIONS).toEqual({});
  });

  // Why this matters beyond tidiness: supabase_migrations.schema_migrations has
  // a PRIMARY KEY on version, so it cannot record two files numbered 0010. That
  // is a hard blocker for Supabase branching AND for the production ledger
  // repair, both of which replay the history into that table.
  it('gives every migration a version the ledger can actually record', () => {
    const seen = new Map<string, string>();
    for (const entry of audit.entries as { name: string; version: string }[]) {
      expect(
        seen.has(entry.version),
        `${entry.version} used by ${seen.get(entry.version)} and ${entry.name}`,
      ).toBe(false);
      seen.set(entry.version, entry.name);
    }
  });

  // The de-duplicated files carry a 5th digit that orders them within their
  // generation (00100 and 00101 both live in 0010). nextVersion reads the first
  // four digits, so those do not drag the next free number up to 1422.
  it('points new migrations at the next unused version', () => {
    // Bumped whenever a migration lands. Stating it rather than deriving it is
    // the point: the number is how a new migration announces itself, so a file
    // that quietly reuses one, or a rebase that drops one, fails here.
    //
    // EIGHT real collisions between two sessions running at once — 0297, 0298
    // (twice, on the same finding), 0299, then 0300, 0301, 0302 and 0303 on
    // four consecutive merges. EVERY merge since 0300 has brought one. Those
    // four are now 0312, 0313, 0314 and 0317, which is why this reads 0319:
    // main holds 0001-0303 and this branch 0304-0318.
    expect(audit.nextVersion).toBe('0319');
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
