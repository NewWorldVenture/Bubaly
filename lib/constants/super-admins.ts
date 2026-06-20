// Super-admin email allowlist resolved at the code/config level — independent
// of the super_admins DB table (migration 0008). This guarantees site-admin
// access works even before that migration is applied, and lets ops add admins
// via the SUPER_ADMIN_EMAILS env var (comma-separated) without a DB change.
//
// The DB-backed is_super_admin() RPC remains the source of truth when present;
// this is an additive fallback, never a downgrade.

const BUILT_IN_SUPER_ADMINS = ['daniel.hughen@gmail.com'];

/** All super-admin emails, lowercased and de-duplicated. */
export function superAdminEmails(): string[] {
  const fromEnv = (process.env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_SUPER_ADMINS, ...fromEnv])];
}

/** True if the email is on the code/env super-admin allowlist (case-insensitive). */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return superAdminEmails().includes(email.toLowerCase());
}
