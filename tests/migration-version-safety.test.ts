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
    // Bumped whenever a migration lands — 0302 keeps one live system policy
    // per family per name. Stating it rather than deriving it is
    // the point: the number is how a new migration announces itself, so a file
    // that quietly reuses one, or a rebase that drops one, fails here.
    //
    // 0318 guardian safety config is manager-only (AUTHZ-005); 0319 the
    // social-access DELETE grant; 0320 the audit_logs actor pin; 0321 the
    // family-erasure indexes. The last three arrived from the audit branch,
    // which had numbered them 0296, 0300 and 0301 before main claimed those —
    // this pin is exactly what surfaced that six-way collision on the merge.
    // Three of that branch's six were dropped rather than renumbered, because
    // main had already fixed the same subjects: family_credentials (0296),
    // sensitive tables incl. child_logins (0297) and invites (0298).
    //
    // 0322 the five wallet side-tables (babysitter_profiles/_payments,
    // gift_links, gift_payments, compliance_disclosures), whose server actions
    // in app/(app)/wallet/actions.ts gate on isManager while 0088's blanket
    // `FOR ALL … is_family_member` did not; 0323 the three safety records
    // (family_emergency_contacts, family_emergency_plans, guardian_suggestions)
    // — the first two named in lib/family/actions.ts's MANAGER_ONLY set, the
    // third the table that FEEDS the contacts 0318 had already closed, so a
    // child could retarget a pending proposal and let a parent's approval apply
    // it. Both moved the number by one file each; neither renumbered anything.
    expect(audit.nextVersion).toBe('0324');
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
