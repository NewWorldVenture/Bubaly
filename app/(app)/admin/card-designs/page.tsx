import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { CardDesignsClient, type DesignRow } from './card-designs-client';

export const metadata: Metadata = { title: 'Card Designs — Bubaly Admin' };

export default async function AdminCardDesignsPage() {
  const supabase = createServiceClient();
  const db = withStripeTables(supabase);
  const gFrom = (t: 'card_designs') => (db.from(t) as ReturnType<typeof supabase.from>);

  const { data } = await gFrom('card_designs')
    .select('id, name, stripe_design_id, requires_physical, is_active, sort_order, created_at')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  const designs: DesignRow[] = (data ?? []) as DesignRow[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fg">Card Designs</h1>
        <p className="text-sm text-muted">
          Custom card designs shown in the card order flow. Each design maps to a Stripe
          personalization design ID — register designs in the Stripe dashboard first, then
          add the ID here.
        </p>
      </div>
      <CardDesignsClient designs={designs} />
    </div>
  );
}
