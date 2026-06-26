'use server';

import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';

type Result = { ok: true } | { ok: false; error: string };

async function guard() {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) throw new Error('Forbidden: admin only');
  return createServiceClient();
}

export async function upsertCardDesignAction(input: {
  id?: string;
  name: string;
  stripeDesignId: string | null;
  requiresPhysical: boolean;
  sortOrder: number;
}): Promise<Result & { id?: string }> {
  const supabase = await guard();
  const db = withStripeTables(supabase);
  const gFrom = (t: 'card_designs') => (db.from(t) as ReturnType<typeof supabase.from>);

  const payload = {
    name: input.name.trim(),
    stripe_design_id: input.stripeDesignId?.trim() || null,
    requires_physical: input.requiresPhysical,
    sort_order: input.sortOrder,
    is_active: true,
  };

  if (input.id) {
    const { error } = await gFrom('card_designs').update(payload).eq('id', input.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: input.id };
  }

  const { data, error } = await gFrom('card_designs').insert(payload).select('id').single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

export async function toggleCardDesignAction(input: { id: string; isActive: boolean }): Promise<Result> {
  const supabase = await guard();
  const db = withStripeTables(supabase);
  const gFrom = (t: 'card_designs') => (db.from(t) as ReturnType<typeof supabase.from>);

  const { error } = await gFrom('card_designs').update({ is_active: input.isActive }).eq('id', input.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteCardDesignAction(input: { id: string }): Promise<Result> {
  const supabase = await guard();
  const db = withStripeTables(supabase);
  const gFrom = (t: 'card_designs') => (db.from(t) as ReturnType<typeof supabase.from>);

  const { error } = await gFrom('card_designs').delete().eq('id', input.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
