import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { EstateModule } from '@/components/modules/estate-module';

export const metadata: Metadata = { title: 'Estate & Legacy Vault' };

export default async function EstatePage() {
  await requireUserContext();
  return <EstateModule />;
}
