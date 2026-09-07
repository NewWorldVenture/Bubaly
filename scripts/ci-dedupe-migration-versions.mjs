// scripts/ci-dedupe-migration-versions.mjs — CI-only helper for `supabase start`.
//
// The repository USED to carry 17 duplicated version prefixes. They have since
// been renamed in the repo itself, using exactly the scheme below, so this
// script now finds nothing to do. It is kept as a safety net for a duplicate
// reintroduced by a future branch.
//
// Why they could not stay: the Supabase CLI records each applied migration in
// supabase_migrations.schema_migrations keyed by version, and that table has a
// PRIMARY KEY on version, so the second file of a pair fails outright:
//   ERROR: duplicate key value violates unique constraint "schema_migrations_pkey"
// That blocked Supabase branching, and would have blocked the production ledger
// repair at the same statement.
//
// When it does have work to do, it runs ONLY in the disposable CI checkout,
// right before `supabase start`, and renames every duplicated group to unique
// versions that keep the exact same apply order (string order, as the CLI sorts
// filenames):
//   0010_blog_posts.sql                 -> 00100_blog_posts.sql
//   0010_support_tickets_admin_users.sql -> 00101_support_tickets_admin_users.sql
// "00100_…" < "00101_…" < "0011_…" and > "0009_…", so nothing moves relative to
// its neighbours. The plan is verified before any file is touched; if the
// order would change, the script aborts without renaming anything.
import { readdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION = /^(\d+)_(.+\.sql)$/;

/**
 * Compute the renames needed to make every migration version unique while
 * preserving the CLI's apply order. Pure — unit-tested from the root suite.
 * @param {string[]} files migration filenames (any order)
 * @returns {{ from: string, to: string }[]}
 */
export function planMigrationDedupe(files) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const file of files) {
    const m = MIGRATION.exec(file);
    if (!m) continue;
    const version = m[1];
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(file);
  }

  /** @type {{ from: string, to: string }[]} */
  const renames = [];
  for (const [version, group] of groups) {
    if (group.length < 2) continue;
    if (group.length > 10) throw new Error(`Migration version ${version} has ${group.length} files; a single suffix digit cannot keep them ordered.`);
    group.sort();
    group.forEach((file, index) => {
      renames.push({ from: file, to: `${version}${index}_${file.slice(version.length + 1)}` });
    });
  }

  // Order guard: the sorted list after renaming must equal the sorted list
  // before renaming, with each renamed file substituted in place.
  const map = new Map(renames.map((r) => [r.from, r.to]));
  const expected = [...files].sort().map((f) => map.get(f) ?? f);
  const actual = files.map((f) => map.get(f) ?? f).sort();
  if (expected.join('\n') !== actual.join('\n')) {
    throw new Error('Renaming would change the migration apply order; aborting without touching any file.');
  }
  const versions = new Set(actual.map((f) => MIGRATION.exec(f)?.[1]).filter(Boolean));
  if (versions.size !== actual.filter((f) => MIGRATION.test(f)).length) {
    throw new Error('Renaming did not yield unique migration versions; aborting.');
  }
  return renames;
}

export function applyMigrationDedupe(dir, { dryRun = false } = {}) {
  const files = readdirSync(dir).filter((f) => MIGRATION.test(f));
  const renames = planMigrationDedupe(files);
  for (const { from, to } of renames) {
    if (!dryRun) renameSync(resolve(dir, from), resolve(dir, to));
    console.log(`${dryRun ? '[dry-run] ' : ''}${from} -> ${to}`);
  }
  return renames;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = resolve(root, 'supabase', 'migrations');
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.CI && !dryRun) {
    console.error('Refusing to rename migrations outside CI (set CI=1 or pass --dry-run).');
    process.exit(2);
  }
  const renames = applyMigrationDedupe(dir, { dryRun });
  console.log(`${renames.length} migration file(s) ${dryRun ? 'would be' : ''} renamed for an isolated apply.`);
}
