import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { GraphModule } from '@/components/modules/graph-module';

export const metadata: Metadata = { title: 'Knowledge Graph | Bubaly' };

export default async function GraphPage() {
  await requireUserContext();
  return <GraphModule />;
}
