// lib/stripe/capabilities.ts — Bubaly Money capability detection.
//
// The single source of truth for "what money features can actually run right
// now". The app has TWO modes:
//
//   • LEDGER mode  — the default. Virtual double-entry ledger, zero Stripe
//     dependency. Always available. Gifts/allowance/chores all work here.
//   • STRIPE mode  — real money via Stripe Connect/Treasury/Issuing. Only
//     available when (a) the server has Stripe credentials AND (b) the matching
//     feature_flags are switched on AND (c) — for a given family — Stripe has
//     actually enabled the capability on their connected account.
//
// Consumer pages NEVER branch on Stripe internals directly. They call
// getMoneyCapabilities() and render from the plain booleans it returns, so the
// app degrades gracefully to the ledger if anything is missing — no crashes, no
// half-built screens. (Per spec: hide Treasury/Issuing/Connect/webhook jargon.)
//
// The resolver below is PURE and unit-tested; the async wrapper just gathers the
// inputs (env presence + feature_flags) and delegates to it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type MoneyMode = 'ledger' | 'stripe';

/** The flags we read from the feature_flags table. */
export type MoneyFlags = {
  stripe_payments_enabled: boolean;   // Checkout for gifts/top-ups
  stripe_connect_enabled: boolean;    // parent onboarding (prerequisite)
  stripe_treasury_enabled: boolean;   // embedded financial accounts
  stripe_issuing_enabled: boolean;    // card issuing
  physical_cards_enabled: boolean;    // order physical cards
  custom_card_designs_enabled: boolean;
};

export const DEFAULT_MONEY_FLAGS: MoneyFlags = {
  stripe_payments_enabled: false,
  stripe_connect_enabled: false,
  stripe_treasury_enabled: false,
  stripe_issuing_enabled: false,
  physical_cards_enabled: false,
  custom_card_designs_enabled: false,
};

/** What the server has the credentials to do, independent of any family. */
export type StripeEnv = {
  /** STRIPE_SECRET_KEY present — required for any live Stripe call. */
  hasSecretKey: boolean;
  /** STRIPE_WEBHOOK_SECRET (or money-specific one) present — required to verify events. */
  hasWebhookSecret: boolean;
};

export type MoneyCapabilities = {
  mode: MoneyMode;
  /** Ledger is always on — it's the foundation everything posts to. */
  ledger: true;
  /** Real money can move in/out (Checkout funded gifts/top-ups). */
  payments: boolean;
  /** Parent onboarding (KYC) is available to start. */
  connectOnboarding: boolean;
  /** Embedded financial accounts available. */
  treasury: boolean;
  /** Card issuing available. */
  issuing: boolean;
  /** Physical card ordering available. */
  physicalCards: boolean;
  /** Custom card designs offered. */
  customCardDesigns: boolean;
  /** Why Stripe mode isn't active (for admin diagnostics only — never shown to consumers). */
  reason: string | null;
};

/**
 * PURE resolver: given the server env + the global flags, decide what can run.
 * Capabilities are layered — Treasury/Issuing require Connect, Connect requires
 * credentials. A capability is only ON if every layer beneath it is ON too.
 */
export function resolveCapabilities(env: StripeEnv, flags: MoneyFlags): MoneyCapabilities {
  // No credentials → ledger only, full stop. This is the graceful-fallback path
  // that keeps the app working in any environment without Stripe configured.
  if (!env.hasSecretKey) {
    return {
      mode: 'ledger', ledger: true, payments: false, connectOnboarding: false,
      treasury: false, issuing: false, physicalCards: false, customCardDesigns: false,
      reason: 'Stripe credentials not configured (STRIPE_SECRET_KEY missing).',
    };
  }

  const connectOnboarding = flags.stripe_connect_enabled;
  // Treasury & Issuing both build on a connected account.
  const treasury = connectOnboarding && flags.stripe_treasury_enabled;
  const issuing = connectOnboarding && flags.stripe_issuing_enabled;
  // Payments (Checkout) can run with just credentials + the payments flag; it
  // doesn't strictly need Connect (platform-charged), but we still gate on env.
  const payments = flags.stripe_payments_enabled && env.hasWebhookSecret;
  const physicalCards = issuing && flags.physical_cards_enabled;
  const customCardDesigns = issuing && flags.custom_card_designs_enabled;

  const anyStripe = payments || connectOnboarding || treasury || issuing;

  return {
    mode: anyStripe ? 'stripe' : 'ledger',
    ledger: true,
    payments,
    connectOnboarding,
    treasury,
    issuing,
    physicalCards,
    customCardDesigns,
    reason: anyStripe ? null : 'All Stripe feature flags are off — running on the virtual ledger.',
  };
}

/** Read the env presence (server-only). Never returns the secret itself. */
export function readStripeEnv(): StripeEnv {
  return {
    hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
    hasWebhookSecret: !!(process.env.STRIPE_MONEY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET),
  };
}

type DB = SupabaseClient<Database>;

/** Load the money-related feature flags and preserve a read error for diagnostic surfaces. */
export async function readMoneyFlagsWithError(supabase: DB): Promise<{ flags: MoneyFlags; error: unknown | null }> {
  const keys = Object.keys(DEFAULT_MONEY_FLAGS) as (keyof MoneyFlags)[];
  const { data, error } = await supabase.from('feature_flags').select('key, enabled').in('key', keys);
  const byKey = new Map((data ?? []).map((r) => [r.key, r.enabled]));
  const out = { ...DEFAULT_MONEY_FLAGS };
  for (const k of keys) out[k] = byKey.get(k) ?? false;
  return { flags: out, error };
}

/** Consumer pages keep the historical ledger fallback; diagnostic pages can use the error-aware helper. */
export async function readMoneyFlags(supabase: DB): Promise<MoneyFlags> {
  const { flags } = await readMoneyFlagsWithError(supabase);
  return flags;
}

/** The async entry point used by pages/actions: env + flags → capabilities. */
export async function getMoneyCapabilities(supabase: DB): Promise<MoneyCapabilities> {
  const flags = await readMoneyFlags(supabase);
  return resolveCapabilities(readStripeEnv(), flags);
}
