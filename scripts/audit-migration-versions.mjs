import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIGRATIONS_DIR = resolve(ROOT, 'supabase', 'migrations');

// These collisions are already part of the repository's historical migration
// lineage. Renaming them without checking applied remote history could create
// drift in a production database.
export const KNOWN_DUPLICATE_MIGRATIONS = Object.freeze({
  '0010': ['0010_blog_posts.sql', '0010_support_tickets_admin_users.sql'],
  '0026': ['0026_display_layouts.sql', '0026_medication_doses.sql'],
  '0042': ['0042_family_location.sql', '0042_loyalty.sql'],
  '0043': ['0043_chore_missions.sql', '0043_wishlists.sql'],
  '0073': ['0073_behavior_tracking.sql', '0073_habits.sql'],
  '0080': ['0080_food_household.sql', '0080_health_wellness.sql'],
  '0089': ['0089_avatars_bucket.sql', '0089_dashboard_layouts.sql'],
  '0090': ['0090_communications_hub.sql', '0090_stripe_money.sql'],
  '0095': ['0095_pay_handles.sql', '0095_wallet_transfers.sql'],
  '0098': ['0098_relationship_helper.sql', '0098_trip_intelligence.sql'],
  '0105': ['0105_calendar_events_rls_repair.sql', '0105_child_logins.sql'],
  '0108': ['0108_album_highlight_kind.sql', '0108_messages_enhance.sql'],
  '0109': [
    '0109_documents_favorite.sql',
    '0109_finance_rls_repair.sql',
    '0109_user_preferences_rls_repair.sql',
  ],
  '0110': ['0110_family_profile.sql', '0110_transactions_member.sql'],
  '0137': ['0137_ai_call_guardian.sql', '0137_child_login_throttle.sql'],
  '0138': ['0138_demo_sessions.sql', '0138_onboarding_imports.sql'],
  '0142': ['0142_family_signals.sql', '0142_poll_facilitation.sql'],
  '0231': ['0231_blog_drop_loremflickr_covers.sql', '0231_blog_hero_photos.sql'],
});

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

  const versions = entries.map(({ version }) => Number(version)).filter(Number.isFinite);
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
