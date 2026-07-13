import { createClient } from '@supabase/supabase-js';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for seed scripts.`);
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(name) {
  const value = requireEnv(name);
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a valid UUID.`);
  return value;
}

/**
 * Require an explicit, confirmed non-production target for legacy seed scripts.
 * The seed scripts use a service-role key and may write or delete family data,
 * so relying on a URL or a hardcoded household ID is not an acceptable guard.
 */
export function requireSeedScope() {
  const environment = requireEnv('SEED_ENVIRONMENT').toLowerCase();
  if (!['local', 'test', 'preview', 'staging'].includes(environment)) {
    throw new Error('SEED_ENVIRONMENT must be local, test, preview, or staging; production seeding is disabled.');
  }

  const familyId = requireUuid('SEED_FAMILY_ID');
  const confirmation = requireEnv('SEED_CONFIRM_FAMILY_ID');
  if (confirmation !== familyId) {
    throw new Error('SEED_CONFIRM_FAMILY_ID must exactly match SEED_FAMILY_ID.');
  }

  return {
    environment,
    familyId,
    createdByUserId: requireUuid('SEED_CREATED_BY_USER_ID'),
  };
}

/**
 * Create a server-only seed client from the process environment.
 * Seed scripts intentionally require an explicit service-role key so a
 * developer cannot accidentally run them against a guessed or stale project.
 */
export function createSeedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL is required for seed scripts.');

  return createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
