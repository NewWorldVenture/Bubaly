import { createClient } from '@supabase/supabase-js';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for seed scripts.`);
  return value;
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
