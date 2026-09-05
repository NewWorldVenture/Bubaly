import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { WatchlistModule } from '@/components/modules/watchlist-module';

export const metadata: Metadata = { title: 'Family Watchlist' };

export default async function WatchlistPage() {
  await requireFeature('/dashboard/watchlist');
  return <WatchlistModule />;
}
