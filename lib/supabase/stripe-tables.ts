// Typed helpers for the Stripe tables added in migration 0090.
// The generated database.types.ts doesn't include these yet (pending migration),
// so we use explicit type casts here rather than polluting the generated file.

import type { SupabaseClient } from '@supabase/supabase-js';

type StripeConnectedAccount = {
  id: string;
  family_id: string;
  account_id: string;
  status: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type StripeCapability = {
  id: string;
  family_id: string;
  account_id: string | null;
  capability_matrix: Record<string, unknown>;
  last_checked_at: string;
  created_at: string;
  updated_at: string;
};

type StripeIssuingCard = {
  id: string;
  family_id: string;
  child_wallet_id: string | null;
  card_id: string;
  cardholder_id: string;
  type: string;
  status: string;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  brand: string | null;
  personalization_design_id: string | null;
  shipping_status: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type StripeAuthorization = {
  id: string;
  family_id: string | null;
  authorization_id: string;
  card_id: string;
  child_wallet_id: string | null;
  status: string;
  decision: string | null;
  decline_reason: string | null;
  amount_cents: number;
  currency: string;
  merchant_name: string | null;
  merchant_category: string | null;
  metadata: Record<string, unknown>;
  authorized_at: string;
  created_at: string;
};

type StripeWebhookEvent = {
  id: string;
  event_id: string;
  type: string;
  livemode: boolean;
  api_version: string | null;
  family_id: string | null;
  status: string;
  error: string | null;
  processed_at: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
};

type StripeCheckoutSession = {
  id: string;
  family_id: string;
  session_id: string;
  type: string;
  status: string;
  amount_cents: number;
  currency: string;
  related_id: string | null;
  metadata: Record<string, unknown>;
  payment_intent_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type StripeCardholder = {
  id: string;
  family_id: string;
  cardholder_id: string;
  status: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type CardControl = {
  id: string;
  family_id: string;
  card_id: string;
  daily_limit_cents: number | null;
  weekly_limit_cents: number | null;
  monthly_limit_cents: number | null;
  per_txn_limit_cents: number | null;
  allow_online: boolean;
  allow_in_store: boolean;
  allow_atm: boolean;
  blocked_categories: string[];
  parent_approval_threshold_cents: number | null;
  created_at: string;
  updated_at: string;
};

type StripeCustomer = {
  id: string;
  family_id: string;
  user_id: string;
  customer_id: string;
  created_at: string;
  updated_at: string;
};

type CardDesign = {
  id: string;
  name: string;
  stripe_design_id: string | null;
  requires_physical: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type StripeTables = {
  stripe_connected_accounts: StripeConnectedAccount;
  stripe_capabilities: StripeCapability;
  stripe_issuing_cards: StripeIssuingCard;
  stripe_authorizations: StripeAuthorization;
  stripe_webhook_events: StripeWebhookEvent;
  stripe_checkout_sessions: StripeCheckoutSession;
  stripe_cardholders: StripeCardholder;
  card_controls: CardControl;
  stripe_customers: StripeCustomer;
  card_designs: CardDesign;
};

/** Cast a Supabase client to also query the Stripe tables from migration 0090. */
export function withStripeTables<T extends SupabaseClient>(client: T) {
  return client as T & {
    from<K extends keyof StripeTables>(relation: K): ReturnType<T['from']>;
  };
}
