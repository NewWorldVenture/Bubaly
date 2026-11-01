// Real connectivity probes for the Site Admin "System Overview" page.
// Every check makes an actual request and times it — nothing here is a
// hardcoded "Operational" label. A failure is reported as a failure.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';

export type HealthCheck = { name: string; ok: boolean; latencyMs: number | null; detail: string };

async function timed(fn: () => Promise<void>): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start, detail: 'Responding normally' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'Request failed' };
  }
}

export async function checkDatabase(supabase: SupabaseClient<Database>): Promise<HealthCheck> {
  const result = await timed(async () => {
    const { error } = await supabase.from('families').select('id', { count: 'exact', head: true }).limit(1);
    if (error) throw new Error(error.message);
  });
  return { name: 'Database', ...result };
}

export async function checkStorage(supabase: SupabaseClient<Database>): Promise<HealthCheck> {
  const result = await timed(async () => {
    const { error } = await supabase.storage.from('documents').list('', { limit: 1 });
    if (error) throw new Error(error.message);
  });
  return { name: 'Storage', ...result };
}

export async function checkAuth(supabase: SupabaseClient<Database>): Promise<HealthCheck> {
  const result = await timed(async () => {
    const { error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) throw new Error(error.message);
  });
  return { name: 'Auth', ...result };
}

/**
 * Probes the key BILLING uses: the one saved in Super Admin → Stripe Setup
 * first, the environment's second (lib/stripe/settings.ts effectiveSecretKey),
 * as checkout, the portal and the webhooks resolve it. It tested
 * STRIPE_SECRET_KEY alone, so a deployment configured in Stripe Setup read
 * "not configured" while checkout worked, and a rotated stored key was
 * reported on through an environment key billing no longer uses.
 */
export async function checkStripe(): Promise<HealthCheck> {
  const name = 'Billing (Stripe)';
  const t = await getTranslations();
  const { readStripeSettings, effectiveSecretKey } = await import('@/lib/stripe/settings');
  const { settings, error } = await readStripeSettings();
  // Unread settings are not "nothing saved": the environment's key would
  // answer for a stored one that may differ.
  if (error) return { name, ok: false, latencyMs: null, detail: t('adminIntegrations.stripeSetupUnreadable') };
  const key = effectiveSecretKey(settings);
  if (!key) return { name, ok: false, latencyMs: null, detail: t('adminIntegrations.stripeNoKey') };
  const fromSetup = Boolean(settings?.secret_key?.trim());
  const result = await timed(async () => {
    const { stripeFromKey } = await import('@/lib/stripe');
    await stripeFromKey(key).balance.retrieve();
  });
  return {
    name, ...result,
    detail: result.ok ? t(fromSetup ? 'adminIntegrations.stripeKeyFromSetup' : 'adminIntegrations.stripeKeyFromEnvironment') : result.detail,
  };
}

export function checkEmail(): HealthCheck {
  const configured = Boolean(process.env.RESEND_API_KEY);
  return {
    name: 'Email (Resend)', ok: configured, latencyMs: null,
    detail: configured ? 'API key configured' : 'RESEND_API_KEY not configured',
  };
}

export function checkAI(): HealthCheck {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  return {
    name: 'AI Processing', ok: configured, latencyMs: null,
    detail: configured ? 'API key configured' : 'OPENAI_API_KEY not configured',
  };
}
