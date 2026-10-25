// lib/stripe/settings.ts — load the super-admin Stripe configuration. Reads the
// locked-down `stripe_settings` singleton via the service role (server only).
// Every value falls back to env so existing deployments keep working until the
// admin saves overrides in Super Admin → Stripe Setup.

import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import type { Tables } from '@/lib/database.types';

export type StripeSettings = Tables<'stripe_settings'>;

/** The Stripe config singleton, or null if the table isn't present yet. */
export async function getStripeSettings(): Promise<StripeSettings | null> {
  try {
    const supabase = createServiceClient();
    const { data } = await supabase.from('stripe_settings').select('*').eq('id', 'singleton').maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

/** The Stripe config singleton (null when none is saved), or the read that could not be made. */
export type StripeSettingsRead =
  | { settings: StripeSettings | null; error: null }
  | { settings: null; error: { message: string } };

/**
 * getStripeSettings for the admin console's Test connection, which asks
 * whether the STORED key works. getStripeSettings drops its read's error, so a
 * refused or unreachable read is "nothing saved" and the environment answers:
 * the test said "No Stripe secret key configured" over a saved key, or tested
 * STRIPE_SECRET_KEY and called the stored config connected (review
 * R9-2-ADMIN-TEST-CONNECTION-FAILED-READ-IS-NO-KEY). The admin caller gets the
 * error and says the settings could not be read. getStripeSettings itself is
 * unchanged: for the runtime callers the environment is the documented
 * fallback. Settled, so a transport rejection arrives the same way.
 */
export async function readStripeSettings(): Promise<StripeSettingsRead> {
  const supabase = createServiceClient();
  const { data, error } = await settle(supabase.from('stripe_settings').select('*').eq('id', 'singleton').maybeSingle());
  if (error) return { settings: null, error };
  return { settings: data ?? null, error: null };
}

/** Effective secret key: configured value first, then env. */
export function effectiveSecretKey(s: StripeSettings | null): string | null {
  return s?.secret_key?.trim() || process.env.STRIPE_SECRET_KEY || null;
}

/** Effective webhook signing secret: configured value first, then env. */
export function effectiveWebhookSecret(s: StripeSettings | null): string | null {
  return s?.webhook_secret?.trim() || process.env.STRIPE_WEBHOOK_SECRET || null;
}

/** Effective publishable key: configured value first, then env. */
export function effectivePublishableKey(s: StripeSettings | null): string | null {
  return s?.publishable_key?.trim() || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null;
}
