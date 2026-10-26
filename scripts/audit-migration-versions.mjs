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

// Production applies migrations with `supabase db push`, in version order, and
// the CLI refuses a local file numbered below the last version the remote
// ledger records ("Found local migration files to be inserted before the last
// migration on remote database") unless it is given --include-all, which the
// production workflow does not pass and should not. So a number below the
// checked-in high-water mark that no file holds is not free. A branch that
// reserved one and lands after a higher number has landed cannot be released
// in order; that is how 0475/0476 came to be claimed twice (#834 and #890),
// 0477 by #958 behind them, and 0488/0489/0490 by three branches that each had
// to wait on the lower ones.
//
// The holes below are retired, the reservations that left them released: work
// that once held one of these numbers takes the next free number when it lands.
// Above the mark the sequence has no gaps, so a migration cannot skip a number
// to save it for later and make a new hole. Never add to this list to quiet a
// red audit — renumber the migration instead.
export const RETIRED_HIGH_WATER = 474
export const RETIRED_MIGRATION_VERSIONS = Object.freeze([
  '0166', '0167', '0287', '0288', '0289', '0334', '0337', '0392', '0393', '0394',
  '0395', '0396', '0397', '0398', '0399', '0400', '0401', '0402', '0403', '0404',
  '0405', '0412', '0413', '0417', '0421', '0422', '0423', '0424', '0425', '0427',
  '0431', '0436', '0437', '0445', '0446', '0465', '0466', '0467', '0468', '0469',
  '0470', '0472', '0473',
])

export function readMigrationInventory(directory = DEFAULT_MIGRATIONS_DIR) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      return match ? { name, version: match[1] } : null;
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

// `supabase migration new` generates UTC timestamps. They are a separate
// version family, not generation 2026 in the historical four-digit sequence.
// Round-trip the calendar date so malformed 14-digit names cannot escape the
// legacy ordering checks by merely looking like timestamps.
export function isTimestampMigrationVersion(version) {
  if (!/^\d{14}$/.test(version)) return false;
  const iso = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}.000Z`;
  const time = new Date(iso);
  return Number.isFinite(time.getTime()) && time.toISOString() === iso;
}

export function auditMigrationVersions(
  directory = DEFAULT_MIGRATIONS_DIR,
  { retired = RETIRED_MIGRATION_VERSIONS, highWater = RETIRED_HIGH_WATER } = {},
) {
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

  const timestampEntries = entries.filter(({ version }) => isTimestampMigrationVersion(version));
  const legacyEntries = entries.filter(({ version }) => /^\d{4,5}$/.test(version));
  const invalidVersions = entries.filter(({ version }) => !/^\d{4,5}$/.test(version) && !isTimestampMigrationVersion(version));

  // Versions are 4-digit generations. The de-duplicated ones carry a 5th digit
  // that orders them WITHIN a generation (00100/00101 both sit in 0010), so the
  // next free number comes from the first four digits — Number('01421') is 1421
  // and would otherwise push the next migration to 1422.
  const versions = legacyEntries
    .map(({ version }) => Number(version.slice(0, 4)))
    .filter(Number.isFinite);
  const nextVersion = String(Math.max(0, ...versions) + 1).padStart(4, '0');

  // A file in a retired hole, or a generation above the mark that leaves the
  // one before it empty. Both are compared on the first four digits, the
  // generation the ledger orders by.
  const retiredSet = new Set(retired);
  const filledHoles = legacyEntries
    .filter(({ version }) => retiredSet.has(version.slice(0, 4)))
    .map(({ name }) => name);
  const generations = new Set(versions);
  const skippedVersions = [];
  for (let generation = highWater + 1; generation < Number(nextVersion); generation += 1) {
    if (!generations.has(generation)) skippedVersions.push(String(generation).padStart(4, '0'));
  }

  return { entries, duplicates, unexpectedDuplicates, nextVersion, filledHoles, skippedVersions, timestampEntries, invalidVersions };
}

function runCli() {
  const audit = auditMigrationVersions();
  console.log(`Migration filename audit: ${audit.entries.length} numbered SQL files.`);

  if (audit.invalidVersions.length > 0) {
    console.error('\nMigration audit failed: a version is neither a legacy generation nor a valid UTC timestamp.');
    for (const { name } of audit.invalidVersions) console.error(`  ${name}`);
    process.exitCode = 1;
    return;
  }

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

  if (audit.filledHoles.length > 0 || audit.skippedVersions.length > 0) {
    console.error('\nMigration audit failed: a migration is numbered out of release order.');
    for (const name of audit.filledHoles) {
      console.error(`  ${name} takes a retired number below ${String(RETIRED_HIGH_WATER).padStart(4, '0')}; production cannot apply it after a higher one.`);
    }
    for (const version of audit.skippedVersions) {
      console.error(`  ${version} is skipped; a later migration may not leave a hole below it.`);
    }
    console.error(`Rename the migration to the next free number (${audit.nextVersion} after the highest file, or the first skipped one).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Migration filename audit passed. Next legacy version: ${audit.nextVersion}; ${audit.timestampEntries.length} UTC timestamp migration(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
