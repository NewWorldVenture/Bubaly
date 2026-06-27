// lib/stripe/settings.ts — load the super-admin Stripe configuration. Reads the
// locked-down `stripe_settings` singleton via the service role (server only).
// Every value falls back to env so existing deployments keep working until the
// admin saves overrides in Super Admin → Stripe Setup.

import { createServiceClient } from '@/lib/supabase/server';
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
