import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIGRATIONS_DIR = resolve(ROOT, 'supabase', 'migrations');

// These collisions are already part of the repository's historical migration
// lineage. Renaming them without checking applied remote history could create
// drift in a production database.
// Historically this repository carried 17 version collisions — two or three
// files sharing one numeric prefix. They are gone: every colliding group was
// renamed to a unique version that keeps the same apply order (0010_blog_posts
// -> 00100_blog_posts, 0010_support_tickets_admin_users -> 00101_…), because
// supabase_migrations.schema_migrations keys on version and physically cannot
// record two rows for 0010. That blocked Supabase branching outright and would
// have blocked the production ledger repair at the same point.
//
// This map stays, deliberately empty: the collision check below still runs, so
// a NEW duplicate fails the audit instead of being quietly absorbed. Do not add
// entries to make a red audit go green — give the new migration a free number.
export const KNOWN_DUPLICATE_MIGRATIONS = Object.freeze({})

export function readMigrationInventory(directory = DEFAULT_MIGRATIONS_DIR) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      return match ? { name, version: match[1] } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function auditMigrationVersions(directory = DEFAULT_MIGRATIONS_DIR) {
  const entries = readMigrationInventory(directory);
  const byVersion = new Map();

  for (const entry of entries) {
    const group = byVersion.get(entry.version) ?? [];
    group.push(entry.name);
    byVersion.set(entry.version, group);
  }

  const duplicates = [...byVersion.entries()]
    .filter(([, names]) => names.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([version, names]) => ({ version, names }));

  const unexpectedDuplicates = duplicates.filter(({ version, names }) => {
    const known = KNOWN_DUPLICATE_MIGRATIONS[version];
    return !known || known.join('|') !== names.join('|');
  });

  // Versions are 4-digit generations. The de-duplicated ones carry a 5th digit
  // that orders them WITHIN a generation (00100/00101 both sit in 0010), so the
  // next free number comes from the first four digits — Number('01421') is 1421
  // and would otherwise push the next migration to 1422.
  const versions = entries
    .map(({ version }) => Number(version.slice(0, 4)))
    .filter(Number.isFinite);
  const nextVersion = String(Math.max(0, ...versions) + 1).padStart(4, '0');

  return { entries, duplicates, unexpectedDuplicates, nextVersion };
}

function runCli() {
  const audit = auditMigrationVersions();
  console.log(`Migration filename audit: ${audit.entries.length} numbered SQL files.`);

  for (const duplicate of audit.duplicates) {
    console.warn(`KNOWN legacy duplicate ${duplicate.version}: ${duplicate.names.join(', ')}`);
  }

  if (audit.unexpectedDuplicates.length > 0) {
    console.error('\nMigration audit failed: an unapproved version collision was found.');
    for (const duplicate of audit.unexpectedDuplicates) {
      console.error(`  ${duplicate.version}: ${duplicate.names.join(', ')}`);
    }
    console.error('Assign a new unused numeric prefix; do not rename applied historical migrations without an owner-approved reconciliation plan.');
    process.exitCode = 1;
    return;
  }

  console.log(`Migration filename audit passed. Next available version: ${audit.nextVersion}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
