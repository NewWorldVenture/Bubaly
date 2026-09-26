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
    // ELEVEN collision EVENTS between two sessions running at once, and
    // twenty-one numbers: 0297, 0298 (twice, on the same finding), 0299, then
    // 0300, 0301, 0302, 0303 on four consecutive merges — then all of 0304-0310
    // in one go when main landed seven at once, then 0311, and now FIVE more
    // (0312-0316) when main landed 0312-0317 while this branch already held
    // 0312-0316. EVERY merge since 0300 has brought one.
    //
    // This branch's five move to 0328-0332, keeping their relative order. Order
    // is not load-bearing and that was CHECKED rather than assumed: they touch
    // medications, medication_schedules, grades, screen_time_limits,
    // behavior_logs, journal_entries, medical_profiles and family_allergies, and
    // main's 0312-0317 touch documents, groceries, meals, marketplace and
    // wallet_transactions — no table appears on both sides, and nothing in this
    // branch's own 0318-0327 goes near the eight either.
    //
    // This reads 0338: main holds 0001-0317, this branch 0318-0327, 0328-0332,
    // 0333 (Guardian screening is a parent's to configure), 0334 (a social
    // restriction is not its holder's to lift), 0335 (a reward is paid for
    // with points that exist), 0336 (a device is buzzed once per
    // notification — a new service-only table, push_deliveries, that no
    // migration on main names) and 0337 (an email event is counted once — a
    // column on resend_webhook_events and a service-only function). 0333 touches only guardian_contacts and
    // guardian_member_profiles, 0334 only social_access_permissions, 0335 only a
    // trigger on reward_redemptions that reads chore_assignments; main's
    // 0312-0317 go near none of them — 0316 ("a chore is paid once") touches
    // wallet_transactions, not the points columns 0335 sums — so the non-overlap
    // argument above still holds, checked against the same list.
    expect(audit.nextVersion).toBe('0338');
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
