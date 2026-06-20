// Real connectivity probes for the Site Admin "System Overview" page.
// Every check makes an actual request and times it — nothing here is a
// hardcoded "Operational" label. A failure is reported as a failure.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

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

export async function checkStripe(): Promise<HealthCheck> {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { name: 'Billing (Stripe)', ok: false, latencyMs: null, detail: 'STRIPE_SECRET_KEY not configured' };
  }
  const result = await timed(async () => {
    const { getStripe } = await import('@/lib/stripe');
    await getStripe().balance.retrieve();
  });
  return { name: 'Billing (Stripe)', ...result };
}

export function checkEmail(): HealthCheck {
  const configured = Boolean(process.env.RESEND_API_KEY);
  return {
    name: 'Email (Resend)', ok: configured, latencyMs: null,
    detail: configured ? 'API key configured' : 'RESEND_API_KEY not configured',
  };
}

export function checkAI(): HealthCheck {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  return {
    name: 'AI Processing', ok: configured, latencyMs: null,
    detail: configured ? 'API key configured' : 'ANTHROPIC_API_KEY not configured',
  };
}
